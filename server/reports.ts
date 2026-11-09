import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import http from "node:http";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import WebSocket from "ws";
import { parse, serialize } from "parse5";
import { Store } from "./store.ts";
import { makeSandboxSpawner, sandbox } from "./sandbox.ts";
import { gateway, tunnel } from "./report-bridge.ts";
import { fileType, localizeInline, previewHtml } from "./media.ts";
import { recentDialogue, translateCatalog } from "./translator.ts";
import { maskOutput, detect, protect, restore } from "./privacy.ts";
import type { Report } from "../shared/reports.ts";
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const filename = (name: string) =>
  createHash("sha256").update(name).digest("hex");
export const SNAPSHOT_SCRIPT = `import os,sys,stat,json,base64
parts=sys.argv[1].split('/')
if parts[:2]!=['','work'] or any(x in ('','.','..') for x in parts[2:]): raise ValueError('Invalid path')
fd=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:]:
  nxt=os.open(part,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd); os.close(fd); fd=nxt
 files={}; total=0
 def walk(current,prefix,depth=0):
  global total
  if depth>16: raise ValueError('Directory too deep')
  info=os.fstat(current)
  if stat.S_ISREG(info.st_mode):
   if len(files)>=1000 or info.st_size>25*1024*1024 or total+info.st_size>25*1024*1024: raise ValueError('Snapshot exceeds limits')
   with os.fdopen(os.dup(current),'rb') as f: data=f.read(25*1024*1024+1)
   total+=len(data)
   if total>25*1024*1024: raise ValueError('Snapshot exceeds limits')
   files[prefix or os.path.basename(sys.argv[1])]=base64.b64encode(data).decode()
  elif stat.S_ISDIR(info.st_mode):
   for name in sorted(os.listdir(current)):
    if name.startswith('.') or name=='node_modules': continue
    child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=current)
    try: walk(child,prefix+name+'/' if stat.S_ISDIR(os.fstat(child).st_mode) else prefix+name,depth+1)
    finally: os.close(child)
  else: raise ValueError('Only regular files and directories are allowed')
 walk(fd,''); print(json.dumps(files))
finally: os.close(fd)
`;

export class Reports {
  constructor(public store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL)",
    );
    mkdirSync(join(store.directory, "reports"), {
      recursive: true,
      mode: 0o700,
    });
    for (const report of this.list())
      if (report.translationState === "pending")
        this.save({ ...report, translationState: "error" });
  }
  save(report: Report) {
    this.store.db
      .prepare(
        "INSERT INTO reports VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(report.id, this.store.seal(report), Date.parse(report.createdAt));
    return report;
  }
  get(id: string): Report {
    const row = this.store.db
      .prepare("SELECT data FROM reports WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw fail("发布不存在", 404);
    const value = this.store.open<Report>(row.data);
    if (
      value.expiresAt &&
      Date.parse(value.expiresAt) < Date.now() &&
      value.state === "running"
    )
      value.state = "stopped";
    return value;
  }
  list(): Report[] {
    return (
      this.store.db
        .prepare("SELECT id FROM reports ORDER BY created DESC")
        .all() as { id: string }[]
    ).map((row) => this.get(row.id));
  }
  async status(report: Report) {
    if (report.kind === "service" && report.state === "running") {
      try {
        const result = await gateway("/status", { id: report.id });
        if (result.state === "stopped")
          return this.save({ ...report, state: "stopped" });
      } catch {}
    }
    return report;
  }
  private directory(id: string) {
    return join(this.store.directory, "reports", id);
  }
  async publish(
    sessionId: string,
    options: {
      path?: string;
      title?: string;
      command?: string;
      cwd?: string;
      port?: number;
      ttlMinutes?: number;
    },
  ) {
    const session = this.store.session(sessionId);
    if (!session) throw fail("会话不存在", 404);
    const report: Report = {
      id: randomUUID(),
      repo: session.repo,
      sessionId,
      title: options.title || "未命名发布",
      createdAt: new Date().toISOString(),
      kind: options.command ? "service" : "static",
      entry: "index.html",
      state: "ready",
    };
    if (options.command) {
      const cwd = options.cwd || "/work";
      if (
        !(cwd === "/work" || cwd.startsWith("/work/")) ||
        cwd.split("/").some((p) => p === ".." || p === ".") ||
        cwd.includes("\0")
      )
        throw fail("工作目录必须位于 /work");
      report.command = options.command;
      report.cwd = cwd;
      report.port = options.port || 8080;
      const result = await gateway("/start", {
        id: report.id,
        repo: report.repo,
        command: report.command,
        cwd,
        port: report.port,
        ttl: (options.ttlMinutes || 120) * 60,
      });
      report.expiresAt = new Date(result.expiresAt * 1000).toISOString();
      report.state = "running";
    } else {
      const path = options.path || "";
      if (
        !path.startsWith("/work/") ||
        path.includes("\0") ||
        path
          .replace(/\/$/, "")
          .slice(6)
          .split("/")
          .some((p) => p === "." || p === ".." || !p)
      )
        throw fail("请选择 /work 下的文件或构建目录");
      await sandbox("/sandbox/start", "POST", { repo: session.repo });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      let raw = "",
        code: number | null;
      try {
        const process = makeSandboxSpawner(session.repo)({
          command: "python3",
          args: ["-c", SNAPSHOT_SCRIPT, path.replace(/\/$/, "")],
          env: {},
          cwd: "/work",
          signal: controller.signal,
        });
        process.stdout.on("data", (chunk) => {
          raw += chunk.toString();
          if (raw.length > 36 * 1024 * 1024) controller.abort();
        });
        const exited = new Promise<number | null>((resolve) =>
          process.on("exit", resolve),
        );
        process.stdin.end();
        code = await exited;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      if (code !== 0)
        throw fail(
          "发布读取失败：请选择不含符号链接的构建目录，最多 1,000 个文件、25 MB。",
        );
      const files = JSON.parse(raw) as Record<string, string>;
      return this.snapshot(report, files);
    }
    return this.save(report);
  }
  snapshot(report: Report, files: Record<string, string>) {
    report.files = {};
    report.size = 0;
    mkdirSync(this.directory(report.id), { recursive: true, mode: 0o700 });
    try {
      const names = Object.keys(files);
      if (!names.length || names.length > 1000)
        throw fail("发布文件数量不符合要求");
      report.entry = names.includes("index.html")
        ? "index.html"
        : names.length === 1
          ? names[0]
          : "index.html";
      if (!files[report.entry]) throw fail("构建目录需要包含 index.html");
      for (const [name, value] of Object.entries(files)) {
        if (!validReportPath(name)) throw fail("发布文件路径不符合要求");
        const bytes = Buffer.from(value, "base64"),
          type = fileType(name, bytes);
        report.size += bytes.length;
        if (report.size > 25 * 1024 * 1024) throw fail("发布超过 25 MB");
        report.files[name] = { mime: type.mime, size: bytes.length };
        writeFileSync(
          join(this.directory(report.id), filename(name)),
          this.store.seal(value),
          { mode: 0o600 },
        );
      }
      this.save(report);
      void this.translate(report.id).catch(() => {});
      return report;
    } catch (error) {
      rmSync(this.directory(report.id), { recursive: true, force: true });
      throw error;
    }
  }
  read(report: Report, name: string) {
    if (!validReportPath(name) || !report.files?.[name])
      throw fail("发布文件不存在", 404);
    return Buffer.from(
      this.store.open<string>(
        readFileSync(join(this.directory(report.id), filename(name)), "utf8"),
      ),
      "base64",
    );
  }
  private jobs = new Map<string, Promise<Report>>();
  private pages = new Map<string, string>();
  servicePage(report: Report, html: string, locale: "en" | "zh") {
    let localized: ReturnType<typeof localizeInline>;
    try {
      localized = localizeInline(html);
    } catch {
      return html;
    }
    if (!this.pages.has(report.id)) {
      if (this.pages.size >= 12)
        this.pages.delete(this.pages.keys().next().value!);
      this.pages.set(report.id, html);
      if (report.translationState !== "done")
        void this.translate(report.id).catch(() => {});
    }
    return previewHtml(
      localized.html,
      localized.catalog,
      report.translatedCatalog,
      locale,
      {},
    );
  }
  translate(id: string): Promise<Report> {
    if (this.jobs.has(id)) return this.jobs.get(id)!;
    const job = this.performTranslation(id).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  private async performTranslation(id: string) {
    let report = this.get(id);
    const source =
      report.kind === "service"
        ? this.pages.get(id)
        : report.files?.[report.entry]?.mime === "text/html"
          ? this.read(report, report.entry).toString()
          : undefined;
    if (!source) return report;
    if (report.translationState === "done") return report;
    report.translationState = "pending";
    this.save(report);
    try {
      const localized = localizeInline(source);
      const bindings = this.store.bindings(report.sessionId);
      for (const value of Object.values(localized.catalog))
        for (const finding of detect(value))
          if (!bindings.some((binding) => binding.value === finding.value))
            bindings.push(finding);
      const catalog = Object.fromEntries(
        Object.entries(localized.catalog).map(([k, v]) => [
          k,
          maskOutput(v, bindings),
        ]),
      );
      const messages = this.store.visibleMessages(report.sessionId);
      const translated = await translateCatalog(
        catalog,
        recentDialogue(messages, bindings),
        "",
      );
      report = this.get(id);
      report.catalog = localized.catalog;
      report.translatedCatalog = Object.fromEntries(
        Object.entries(translated).map(([k, v]) => [k, restore(v, bindings)]),
      );
      report.translationState = "done";
      return this.save(report);
    } catch (error) {
      try {
        report = this.get(id);
        report.translationState = "error";
        this.save(report);
      } catch {}
      throw error;
    }
  }
  async stop(id: string) {
    const report = this.get(id);
    if (report.kind === "service") {
      await gateway("/stop", { id });
      report.state = "stopped";
    }
    return this.save(report);
  }
  async remove(id: string) {
    const report = this.get(id);
    if (report.kind === "service" && report.state === "running")
      await this.stop(id);
    this.store.db.prepare("DELETE FROM reports WHERE id=?").run(id);
    rmSync(this.directory(id), { recursive: true, force: true });
  }
}
export function validReportPath(value: string) {
  return (
    !!value &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((p) => p && p !== "." && p !== "..")
  );
}
export function reportPolicy(origin: string, base: string) {
  const source = origin + base;
  return `default-src 'none'; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src data: ${source}; media-src data: blob: ${source}; connect-src ${source} ${source.replace(/^http/, "ws")}; object-src 'none'; base-uri ${source}; form-action ${source}; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-downloads`;
}
export function reportHtml(html: string, base: string) {
  // Classic inline bootstrap fixes root-relative URLs; bundled modules should use relative imports.
  const bootstrap = `<base href=${JSON.stringify(base)}><script>(()=>{const base=${JSON.stringify(base)}, fix=u=>typeof u==='string'&&u.startsWith('/')&&!u.startsWith('//')?base+u.slice(1):u;const native=window.fetch;window.fetch=(u,o)=>native(typeof u==='string'?fix(u):u,o);const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return open.call(this,m,fix(u),...a)};const WS=window.WebSocket;window.WebSocket=class extends WS{constructor(u,p){let v=new URL(fix(u),location.href);if(v.protocol==='http:')v.protocol='ws:';if(v.protocol==='https:')v.protocol='wss:';super(v,p)}};})();</script>`;
  const document = parse(html.replace(/<base\b[^>]*>/gi, "")) as any;
  const visit = (node: any) => {
    for (const attr of node.attrs || []) {
      if (
        ["href", "src", "action", "poster"].includes(attr.name) &&
        attr.value.startsWith("/") &&
        !attr.value.startsWith("//") &&
        !attr.value.startsWith(base)
      )
        attr.value = base + attr.value.slice(1);
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(document);
  const clean = serialize(document);
  return /<head\b[^>]*>/i.test(clean)
    ? clean.replace(/<head\b[^>]*>/i, (match) => match + bootstrap)
    : bootstrap + clean;
}

export function registerReports(
  app: FastifyInstance,
  reports: Reports,
  authenticated: (req: FastifyRequest) => boolean,
) {
  const caps = new Map<
    string,
    { id: string; login: string; expires: number }
  >();
  app.get("/api/reports", async () =>
    (
      await Promise.all(reports.list().map((report) => reports.status(report)))
    ).map(({ command, ...report }) => report),
  );
  app.get<{ Params: { id: string } }>("/api/reports/:id", (req) =>
    reports.status(reports.get(req.params.id)),
  );
  app.post<{ Params: { id: string } }>("/api/reports/:id/view", async (req) => {
    const report = await reports.status(reports.get(req.params.id)),
      cap = randomBytes(24).toString("hex");
    for (const [key, value] of caps)
      if (value.expires < Date.now()) caps.delete(key);
    if (caps.size >= 500) caps.delete(caps.keys().next().value!);
    caps.set(cap, {
      id: report.id,
      login: req.cookies.folio_session || "",
      expires: Date.now() + 12 * 3600000,
    });
    return { report, src: `/report/${report.id}/content/${cap}/` };
  });
  app.post<{ Params: { id: string } }>("/api/reports/:id/stop", (req) =>
    reports.stop(req.params.id),
  );
  app.delete<{ Params: { id: string } }>("/api/reports/:id", async (req) => {
    await reports.remove(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/reports/:id/translate", (req) =>
    reports.translate(req.params.id),
  );
  app.get<{ Params: { id: string } }>("/api/reports/:id/logs", async (req) => {
    const r = reports.get(req.params.id);
    return r.kind === "service"
      ? gateway("/logs", { id: r.id })
      : { text: "静态发布无需运行进程" };
  });
  const validate = (
    req: FastifyRequest<{ Params: { id: string; cap: string; "*": string } }>,
  ) => {
    const cap = caps.get(req.params.cap);
    if (
      !cap ||
      cap.id !== req.params.id ||
      cap.expires < Date.now() ||
      !authenticated({
        ...req,
        cookies: { folio_session: cap.login },
      } as FastifyRequest)
    )
      throw fail("展示授权已过期，请重新打开报告", 401);
    const report = reports.get(req.params.id);
    let path: string;
    try {
      path = decodeURIComponent(req.params["*"] || "");
    } catch {
      throw fail("路径无效");
    }
    if (path && !validReportPath(path.replace(/\/$/, "")))
      throw fail("路径无效");
    return {
      report,
      base: `/report/${report.id}/content/${req.params.cap}/`,
      path,
    };
  };
  type ContentRequest = FastifyRequest<{
    Params: { id: string; cap: string; "*": string };
  }>;
  const route = {
    url: "/report/:id/content/:cap/*",
    bodyLimit: 25 * 1024 * 1024,
    wsHandler: (ws: WebSocket, req: ContentRequest) => {
      let upstream: WebSocket | undefined;
      let closed = false;
      const queued: { data: WebSocket.RawData; binary: boolean }[] = [];
      ws.on("close", () => {
        closed = true;
        upstream?.close();
      });
      ws.on("error", () => upstream?.terminate());
      ws.on("message", (data, binary) => {
        if (upstream?.readyState === 1) upstream.send(data, { binary });
        else if (queued.length < 16) queued.push({ data, binary });
        else ws.close(1009);
      });
      void (async () => {
        const { report, path } = validate(req);
        if (report.kind !== "service" || report.state !== "running")
          throw fail("服务已停止");
        const socket = await tunnel(report.id);
        if (closed) {
          socket.destroy();
          return;
        }
        upstream = new WebSocket(
          `ws://publication/${path}${new URL(req.url, "http://local").search}`,
          ws.protocol ? [ws.protocol] : [],
          {
            createConnection: () => socket,
            maxPayload: 1024 * 1024,
            handshakeTimeout: 15000,
          },
        );
        upstream.on("open", () => {
          for (const item of queued)
            upstream!.send(item.data, { binary: item.binary });
          queued.length = 0;
        });
        upstream.on("message", (data, binary) => {
          if (ws.readyState === 1) {
            if (ws.bufferedAmount > 2 * 1024 * 1024) ws.close(1009);
            else ws.send(data, { binary });
          }
        });
        upstream.on("close", () => ws.close());
        upstream.on("error", () => ws.close(1011));
      })().catch(() => ws.close(1008));
    },
    handler: async (req: ContentRequest, reply: FastifyReply) => {
      const { report, path, base } = validate(req);
      const origin = `${req.protocol}://${req.headers.host}`;
      reply
        .header("content-security-policy", reportPolicy(origin, base))
        .header("referrer-policy", "no-referrer")
        .header("access-control-allow-origin", "null")
        .header(
          "access-control-allow-methods",
          "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        )
        .header("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") return reply.code(204).send();
      if (report.kind === "static") {
        if (!["GET", "HEAD"].includes(req.method))
          throw fail("静态报告只支持读取", 405);
        const name = path
          ? path.endsWith("/")
            ? path + "index.html"
            : path
          : report.entry;
        const bytes = reports.read(report, name),
          mime = report.files![name].mime;
        reply.type(mime);
        if (mime === "text/html") {
          let html = bytes.toString();
          if (name === report.entry) {
            try {
              const localized = localizeInline(html);
              html = previewHtml(
                localized.html,
                localized.catalog,
                report.translatedCatalog,
                new URL(req.url, "http://local").searchParams.get("locale") ===
                  "en"
                  ? "en"
                  : "zh",
                {},
              );
            } catch {
              /* A large or nonlocalizable page remains viewable in its original language. */
            }
          }
          return reportHtml(html, base);
        }
        if (mime === "text/css")
          return bytes
            .toString()
            .replace(
              /url\(\s*(['"]?)\/(?!\/)([^'"\)]+)\1\s*\)/g,
              (_m, _q, path) => `url("${base}${path}")`,
            );
        return bytes;
      }
      if (report.state !== "running") throw fail("服务已停止", 410);
      const socket = await tunnel(report.id);
      const body =
        req.body === undefined
          ? undefined
          : Buffer.isBuffer(req.body)
            ? req.body
            : typeof req.body === "string"
              ? Buffer.from(req.body)
              : Buffer.from(JSON.stringify(req.body));
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        for (const key of ["accept", "content-type", "last-event-id", "range"])
          if (req.headers[key]) headers[key] = String(req.headers[key]);
        if (body) headers["content-length"] = String(body.length);
        const agent = new http.Agent();
        agent.createConnection = () => socket;
        const request = http.request(
          {
            hostname: "publication",
            path: "/" + path + new URL(req.url, "http://local").search,
            method: req.method,
            headers,
            agent,
          },
          (upstream) => {
            reply.code(upstream.statusCode || 502);
            for (const key of [
              "content-type",
              "content-range",
              "accept-ranges",
            ])
              if (upstream.headers[key])
                reply.header(key, upstream.headers[key]);
            const location = upstream.headers.location;
            if (location) {
              if (/^(?:[a-z]+:|\/\/)/i.test(location)) {
                upstream.destroy();
                reject(fail("服务不能重定向到外部地址", 502));
                return;
              }
              reply.header(
                "location",
                location.startsWith("/") ? base + location.slice(1) : location,
              );
            }
            if (
              String(upstream.headers["content-type"]).includes("text/html")
            ) {
              const chunks: Buffer[] = [];
              let size = 0;
              upstream.on("data", (chunk) => {
                size += chunk.length;
                if (size > 5 * 1024 * 1024) {
                  request.destroy();
                  reject(fail("HTML 超过 5 MB", 502));
                } else chunks.push(chunk);
              });
              upstream.on("end", () =>
                resolve(
                  reply.send(
                    reportHtml(
                      path === "" || path === "index.html"
                        ? reports.servicePage(
                            report,
                            Buffer.concat(chunks).toString(),
                            new URL(req.url, "http://local").searchParams.get(
                              "locale",
                            ) === "en"
                              ? "en"
                              : "zh",
                          )
                        : Buffer.concat(chunks).toString(),
                      base,
                    ),
                  ),
                ),
              );
              upstream.on("error", () => reject(fail("服务响应中断", 502)));
            } else resolve(reply.send(upstream));
          },
        );
        request.setTimeout(600000, () => request.destroy());
        reply.raw.on("close", () => request.destroy());
        request.on("error", () => {
          socket.destroy();
          reject(fail("发布服务连接失败", 502));
        });
        request.end(body);
      });
    },
  };
  app.route({ ...route, method: "GET" });
  app.route({
    ...route,
    wsHandler: undefined,
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}
