import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  randomUUID,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { z, ZodError } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, hasPassword, persistConfig } from "./config.ts";
import { verifyPassword } from "./settings.ts";
import { registerSetup } from "./setup.ts";
import { Store } from "./store.ts";
import {
  detect,
  makeFinding,
  protect,
  materialize,
  restore,
  maskOutput,
} from "./privacy.ts";
import { translate, recentDialogue } from "./translator.ts";
import { RuntimeManager } from "./runtime.ts";
import { makeSandboxSpawner, sandbox, authStatus } from "./sandbox.ts";
import { SandboxLogins } from "./sandbox-login.ts";
import { usesWebLogin } from "./auth-config.ts";
import { Quotas } from "./quota.ts";
import { HTML_POLICY, previewHtml } from "./media.ts";
import { sandboxTokens } from "../shared/usage.ts";
import { MAX_ASSET_BYTES } from "./files.ts";
import { registerShell } from "./shell.ts";
import { registerReports } from "./reports.ts";
import { gateway } from "./report-bridge.ts";
import { DeviceLogins, LOGIN_SECONDS } from "./logins.ts";
import type { Review } from "../shared/types.ts";

const app = Fastify({
  logger: false,
  bodyLimit: 256 * 1024,
  trustProxy: process.env.TRUST_PROXY === "1" ? "127.0.0.1" : false,
});
await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
const store = new Store();
const reviews = new Map<string, Review>();
const logins = new DeviceLogins(store);
const attempts = new Map<string, { count: number; time: number }>();
const runtime = new RuntimeManager(store);
const quotas = new Quotas(runtime);
const liveStreams = new Set<import("node:http").ServerResponse>();
const sandboxLogins = new SandboxLogins(async (repo) => {
  if (
    runtime.isBusy(repo) ||
    runtime.dispatches.has(repo) ||
    runtime.reservations.has(repo)
  )
    throw fail("请先结束此沙箱正在执行的任务，再切换登录方式。", 409);
  await runtime.closeRepo(repo);
});
runtime.authBusy = (repo) => sandboxLogins.busy(repo);
const repoSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const session = (id: string) => {
  const s = store.session(id);
  if (!s) throw fail("会话不存在", 404);
  return s;
};
const review = (id: string) => {
  const r = reviews.get(id);
  if (!r || Date.now() - Date.parse(r.createdAt) > 2 * 3600000)
    throw fail("审阅已过期，请重新检查", 404);
  return r;
};
const busy = (repo: string) => runtime.isBusy(repo);
const publicConfig = () => ({
  translator: config.translateModel,
  translatorUrl: config.translateUrl,
  translatorReady: !!config.translateUrl,
  sandboxUrl: config.sandboxUrl,
  oauthConfigured: !!config.oauth,
  retentionDays: config.retentionDays,
  authRequired: hasPassword(),
  translatorProtocol: config.translatorProtocol,
  defaultRepo: config.defaultRepo,
  visionModel: config.visionModel,
  visionUrl: config.visionUrl,
});
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer", bodyLimit: MAX_ASSET_BYTES },
  (_req, body, done) => done(null, body),
);
app.addContentTypeParser(
  "*",
  { parseAs: "buffer", bodyLimit: MAX_ASSET_BYTES },
  (_req, body, done) => done(null, body),
);

app.addHook("onRequest", async (req, reply) => {
  if (
    req.url.startsWith("/api/shell/") &&
    req.headers.origin !== `${req.protocol}://${req.headers.host}`
  )
    throw fail("请求来源不匹配", 403);
  if (!req.url.startsWith("/api/")) return;
  if (!hasPassword() && !config.setupToken) {
    const hostname = new URL(`http://${req.headers.host || "invalid"}`)
      .hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
      throw fail("无密码工作台仅接受本机 Host", 403);
  }
  reply.header("cache-control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw fail("拒绝跨站请求", 403);
    if (
      req.headers.origin &&
      req.headers.origin !== `${req.protocol}://${req.headers.host}`
    )
      throw fail("请求来源不匹配", 403);
  }
  const path = req.url.split("?")[0];
  if (
    [
      "/api/auth",
      "/api/setup/status",
      "/api/setup/unlock",
      "/api/health",
    ].includes(path)
  )
    return;
  const cookie = req.cookies.folio_session || "";
  const expiry = logins.get(cookie) || 0;
  const authenticated = expiry > Date.now();
  if (
    authenticated &&
    config.setupComplete &&
    expiry < Date.now() + (LOGIN_SECONDS - 86400) * 1000
  ) {
    logins.set(cookie, Date.now() + LOGIN_SECONDS * 1000);
    reply.setCookie("folio_session", cookie, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: req.protocol === "https",
      maxAge: LOGIN_SECONDS,
    });
  }
  if (!config.setupComplete) {
    if (!path.startsWith("/api/setup/")) throw fail("请先完成首次配置", 428);
    if ((config.setupToken || hasPassword()) && !authenticated)
      throw fail("请先验证安装码或现有访问密码", 401);
    return;
  }
  if (!hasPassword()) return;
  if (!authenticated) {
    reply.code(401);
    throw fail("请先解锁工作台", 401);
  }
});
// Older clients may send an empty DELETE with a JSON content type.
app.addHook("preParsing", async (req, _reply, payload) => {
  if (
    req.method === "DELETE" &&
    /^application\/json(?:;|$)/i.test(
      String(req.headers["content-type"] || ""),
    ) &&
    !req.headers["transfer-encoding"] &&
    (!req.headers["content-length"] || req.headers["content-length"] === "0")
  )
    delete req.headers["content-type"];
  return payload;
});
app.addHook("onSend", async (_req, reply, payload) => {
  if (/^\/report\/[^/]+\/content\//.test(_req.url)) {
    reply
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store");
    return payload;
  }
  const preview = /^\/api\/assets\/[^/]+\/preview(?:\?|$)/.test(_req.url);
  reply
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "same-origin");
  if (!preview) reply.header("x-frame-options", "DENY");
  reply.header(
    "content-security-policy",
    preview
      ? HTML_POLICY
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https: http:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'",
  );
  return payload;
});
app.setErrorHandler((error, _req, reply) => {
  const status =
    error instanceof ZodError
      ? 400
      : (error as { statusCode?: number }).statusCode || 500;
  // Never serialize upstream responses, SDK stderr, request bodies, or credentials.
  const message =
    error instanceof ZodError
      ? "请求参数不符合要求"
      : error instanceof Error
        ? error.message
        : "操作失败";
  reply.code(status).send({
    error: message.replace(/(?:sk-ant-|ccsb_)[\w-]+/g, "[credential]"),
  });
});
app.get("/api/auth", async (req) => ({
  required: hasPassword(),
  setupRequired: !config.setupComplete,
  loggedIn:
    !hasPassword() ||
    (logins.get(req.cookies.folio_session || "") || 0) > Date.now(),
}));
app.post("/api/auth", async (req, reply) => {
  if (!hasPassword()) throw fail("请先完成首次配置", 401);
  const a = attempts.get(req.ip);
  if (a && a.count >= 8 && Date.now() - a.time < 600000)
    throw fail("尝试过于频繁，请十分钟后重试", 429);
  const { password } = z
    .object({ password: z.string().max(512) })
    .parse(req.body);
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const valid = config.passwordHash
    ? await verifyPassword(password, config.passwordHash)
    : timingSafeEqual(hash(password), hash(config.password));
  if (!valid) {
    attempts.set(req.ip, { count: (a?.count || 0) + 1, time: Date.now() });
    throw fail("访问密码不正确", 401);
  }
  const token = randomBytes(32).toString("hex");
  logins.set(token, Date.now() + LOGIN_SECONDS * 1000);
  attempts.delete(req.ip);
  reply.setCookie("folio_session", token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: req.protocol === "https",
    maxAge: LOGIN_SECONDS,
  });
  return { ok: true };
});
registerSetup(app, store, logins);
app.post("/api/auth/logout", async (req, reply) => {
  logins.delete(req.cookies.folio_session || "");
  reply.clearCookie("folio_session", { path: "/" });
  return { ok: true };
});
registerShell(app);
registerReports(
  app,
  runtime.reports,
  (req) =>
    !hasPassword() ||
    (logins.get(req.cookies.folio_session || "") || 0) > Date.now(),
);
app.get("/api/config", async () => publicConfig());
app.post("/api/config", async (req) => {
  if ([...runtime.runs.values()].some((r) => !r.done))
    throw fail("请先结束正在执行的任务", 409);
  const b = z
    .object({
      oauthToken: z.string().max(8192).optional(),
      translatorUrl: z.string().url().optional().or(z.literal("")),
      translatorModel: z.string().min(1).max(128),
      translatorProtocol: z
        .enum(["auto", "openai", "thinking", "qwen", "off"])
        .optional(),
      translatorKey: z.string().max(8192).optional(),
      visionModel: z.string().max(200).optional(),
      visionUrl: z.string().max(2048).url().optional().or(z.literal("")),
      visionKey: z.string().max(8192).optional(),
    })
    .parse(req.body);
  if (
    b.translatorUrl &&
    !["http:", "https:"].includes(new URL(b.translatorUrl).protocol)
  )
    throw fail("翻译接口只支持 HTTP(S)");
  if (
    b.visionUrl &&
    !["http:", "https:"].includes(new URL(b.visionUrl).protocol)
  )
    throw fail("视觉接口只支持 HTTP(S)");
  persistConfig({
    translateUrl: b.translatorUrl || "",
    translateModel: b.translatorModel,
    translatorProtocol: b.translatorProtocol || config.translatorProtocol,
    oauth: b.oauthToken || config.oauth,
    translateKey: b.translatorKey || config.translateKey,
    visionModel: b.visionModel ?? config.visionModel,
    visionUrl: b.visionUrl ?? config.visionUrl,
    visionKey: b.visionKey || config.visionKey,
  });
  // Reviews must be scanned/translated again after connection changes.
  await runtime.shutdown();
  reviews.clear();
  return publicConfig();
});
app.get("/api/sessions", async () => store.sessions());
app.post<{ Params: { id: string } }>(
  "/api/uploads/:id",
  { bodyLimit: MAX_ASSET_BYTES },
  async (req) => {
    const s = session(z.string().uuid().parse(req.params.id));
    if (!Buffer.isBuffer(req.body)) throw fail("请选择文件");
    let name = "file";
    try {
      name = decodeURIComponent(String(req.headers["x-file-name"] || "file"));
    } catch {
      throw fail("文件名编码无效");
    }
    return runtime.media.upload(s.id, name, req.body);
  },
);
app.get<{ Params: { id: string } }>("/api/assets/:id", async (req) =>
  runtime.media.get(z.string().uuid().parse(req.params.id)),
);
app.post("/api/inline", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
  const b = z
    .object({
      sessionId: z.string().uuid(),
      kind: z.enum(["html", "svg", "image"]),
      source: z
        .string()
        .min(1)
        .max(6 * 1024 * 1024),
    })
    .parse(req.body);
  return runtime.media.inline(b.sessionId, b.kind, b.source);
});
app.post<{ Params: { id: string } }>(
  "/api/assets/:id/decisions",
  async (req) => {
    const b = z
      .object({
        decisions: z
          .array(
            z.object({
              id: z.string(),
              strategy: z.enum(["pass", "placeholder"]),
            }),
          )
          .max(300)
          .default([]),
        allowUnscanned: z.boolean().default(false),
      })
      .parse(req.body);
    return runtime.media.decide(
      z.string().uuid().parse(req.params.id),
      b.decisions,
      b.allowUnscanned,
    );
  },
);
app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(
  "/api/assets/:id/content",
  async (req, reply) => {
    const asset = runtime.media.get(z.string().uuid().parse(req.params.id));
    const inline =
      req.query.inline === "1" &&
      asset.kind === "image" &&
      [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
        "image/avif",
      ].includes(asset.mime);
    reply
      .type(inline ? asset.mime : "application/octet-stream")
      .header(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
      );
    return store.assetBytes(asset.id);
  },
);
app.get<{ Params: { id: string }; Querystring: { locale?: string } }>(
  "/api/assets/:id/preview",
  async (req, reply) => {
    const asset = runtime.media.get(z.string().uuid().parse(req.params.id));
    if (asset.kind !== "html" || !asset.previewReady)
      throw fail(asset.previewError || "此文件没有 HTML 预览");
    const descriptions = Object.fromEntries(
      (asset.children || []).map((id) => {
        const a = runtime.media.get(id, asset.sessionId);
        return [
          id,
          req.query.locale === "en"
            ? a.description || ""
            : a.descriptionZh || "",
        ];
      }),
    );
    reply.type("text/html; charset=utf-8");
    return previewHtml(
      store.derivative(asset.id).toString("utf8"),
      asset.catalog || {},
      asset.translatedCatalog,
      req.query.locale === "en" ? "en" : "zh",
      descriptions,
    );
  },
);
app.post<{ Params: { id: string } }>("/api/assets/:id/translate", async (req) =>
  runtime.media.translate(z.string().uuid().parse(req.params.id)),
);
app.post<{ Params: { id: string } }>("/api/blocks/:id/translate", async (req) =>
  runtime.translations.translate(z.string().uuid().parse(req.params.id)),
);
app.post<{ Params: { id: string } }>(
  "/api/messages/:id/translate",
  async (req) => {
    const b = z.object({ sessionId: z.string().uuid() }).parse(req.body);
    const m = store.messages(b.sessionId).find((m) => m.id === req.params.id);
    if (!m) throw fail("消息不存在", 404);
    if (m.blockId) return runtime.translations.translate(m.blockId);
    const block: import("../shared/types.ts").TraceBlock = {
      id: randomUUID(),
      sessionId: b.sessionId,
      runId: m.runId || "legacy",
      createdAt: m.createdAt,
      kind: "final",
      title: "Claude Code",
      original: m.original,
      messageId: m.id,
      translationState: "none",
    };
    store.saveBlock(block);
    store.updateMessage(b.sessionId, m.id, { blockId: block.id });
    return runtime.translations.translate(block.id);
  },
);
app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/preferences",
  async (req) => {
    const s = session(req.params.id),
      b = z
        .object({ downstreamMode: z.enum(["all", "messages", "manual"]) })
        .parse(req.body);
    s.downstreamMode = b.downstreamMode;
    store.save(s);
    return s;
  },
);
app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
  "/api/sessions/:id/quota",
  async (req) => quotas.get(req.params.id, req.query.refresh === "1"),
);
app.get<{ Params: { id: string }; Querystring: { stream?: string } }>(
  "/api/sessions/:id/events",
  async (req, reply) => {
    const s = session(req.params.id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    liveStreams.add(reply.raw);
    const send = (type: string, value: unknown) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const listener = (value: any) => {
      if (value.sessionId !== s.id) return;
      if (value.live?.delta !== undefined && req.query.stream !== "delta")
        send("change", {
          ...value,
          live: {
            runId: value.live.runId,
            text: runtime.activeFor(s.id)?.output || "",
          },
        });
      else send("change", value);
    };
    store.events.on("change", listener);
    send("snapshot", {
      messages: store.visibleMessages(s.id),
      blocks: store.blocks(s.id),
      assets: store.assets(s.id),
      activities: store.activities.list(s.id),
      live: runtime.activeFor(s.id)?.done
        ? null
        : {
            runId: runtime.activeFor(s.id)?.id,
            text: runtime.activeFor(s.id)?.output || "",
          },
    });
    const timer = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 20000);
    reply.raw.on("close", () => {
      clearInterval(timer);
      store.events.off("change", listener);
      liveStreams.delete(reply.raw);
    });
  },
);
app.post("/api/sessions", async (req) => {
  const b = z.object({ repo: repoSchema }).parse(req.body);
  return store.create(b.repo);
});
app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
  "/api/sessions/:id",
  async (req) => {
    const s = session(req.params.id);
    if (req.query.tail === "1")
      return { session: s, messages: store.visibleMessages(s.id, 8) };
    return {
      session: s,
      messages: store.visibleMessages(s.id),
      blocks: store.blocks(s.id),
      assets: store.assets(s.id),
      activities: store.activities.list(s.id),
      runId: runtime.activeFor(s.id)?.done
        ? undefined
        : runtime.activeFor(s.id)?.id,
    };
  },
);
app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
  const s = session(req.params.id);
  if (busy(s.repo)) throw fail("请先中断任务", 409);
  await runtime.close(s.id);
  store.remove(s.id);
  for (const [id, r] of reviews) if (r.sessionId === s.id) reviews.delete(id);
  return { ok: true };
});
const runOptions = z.object({
  model: z.string().min(1).max(200).default("default"),
  permissionMode: z
    .enum([
      "auto",
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "bypassPermissions",
    ])
    .default("auto"),
  effort: z
    .enum(["default", "off", "low", "medium", "high", "xhigh", "max"])
    .default("default"),
  downstreamMode: z.enum(["all", "messages", "manual"]).default("messages"),
});
function createReview(
  sessionId: string,
  prompt: string,
  mode: "automatic" | "manual" | "direct",
  steering: boolean,
  attachments: string[] = [],
): Review {
  session(sessionId);
  const assets = runtime.media.validate(sessionId, attachments);
  const findings = detect(prompt);
  for (const previous of store.bindings(sessionId)) {
    let start = prompt.indexOf(previous.value);
    if (
      start >= 0 &&
      !findings.some(
        (f) =>
          f.value === previous.value ||
          (start < f.end && start + previous.value.length > f.start),
      )
    )
      findings.push(
        makeFinding(
          previous.kind,
          previous.label,
          previous.value,
          start,
          start + previous.value.length,
          previous.secret,
        ),
      );
  }
  findings.sort((a, b) => a.start - b.start);
  const r: Review = {
    id: randomUUID(),
    sessionId,
    original: prompt,
    findings,
    status: "review",
    mode,
    steering,
    createdAt: new Date().toISOString(),
    attachments,
    attachmentVersions: Object.fromEntries(
      assets.map((a) => [a.id, a.revision]),
    ),
  };
  reviews.set(r.id, r);
  return r;
}
async function prepare(r: Review) {
  if (!["review", "prepared"].includes(r.status))
    throw fail("此审阅已在处理", 409);
  if (r.findings.some((f) => ["pending", "rewrite"].includes(f.strategy)))
    throw fail("请处理全部隐私标记");
  const snapshot = JSON.stringify(r.findings);
  r.status = "preparing";
  const activityId = "prepare:" + r.id;
  store.activities.set(r.sessionId, activityId, "preparing", {
    scope: "upstream",
  });
  try {
    const bindings = [...store.bindings(r.sessionId), ...r.findings];
    const attachments = runtime.media.validate(r.sessionId, r.attachments);
    r.attachmentVersions = Object.fromEntries(
      attachments.map((a) => [a.id, a.revision]),
    );
    const refs = runtime.media.references(
      protect(r.original, r.findings),
      attachments,
    );
    const protectedInput = refs.text;
    const command = r.original.startsWith("/")
      ? /^(\/[^\s]+)\s*([\s\S]*)$/.exec(protectedInput)
      : null;
    if (r.mode !== "direct" && !(command && !command[2]))
      store.activities.set(r.sessionId, activityId, "translating", {
        scope: "upstream",
        detail: r.steering ? "插话" : undefined,
      });
    const translated =
      r.mode === "direct"
        ? protectedInput
        : command && !command[2]
          ? ""
          : await translate(
              command ? command[2] : protectedInput,
              "en",
              undefined,
              recentDialogue(store.visibleMessages(r.sessionId), bindings),
            );
    const english =
      r.mode === "direct"
        ? translated
        : command
          ? command[1] + (translated ? " " + translated : "")
          : translated;
    if (JSON.stringify(r.findings) !== snapshot)
      throw fail("隐私选择已变化，请重新翻译", 409);
    r.masked = refs.restore(english);
    r.english = materialize(r.masked, r.findings);
    r.status = "prepared";
    return r;
  } catch (error) {
    r.status = "review";
    throw error;
  } finally {
    store.activities.clear(r.sessionId, activityId);
  }
}
app.post("/api/reviews", async (req) => {
  const b = z
    .object({
      sessionId: z.string().uuid(),
      prompt: z.string().trim().min(1).max(50000),
      mode: z.enum(["automatic", "manual", "direct"]).default("manual"),
      steering: z.boolean().default(false),
      attachments: z.array(z.string().uuid()).max(12).default([]),
    })
    .parse(req.body);
  return createReview(b.sessionId, b.prompt, b.mode, b.steering, b.attachments);
});
app.patch<{ Params: { id: string } }>("/api/reviews/:id", async (req) => {
  const r = review(req.params.id);
  if (!["review", "prepared"].includes(r.status))
    throw fail("此审阅已在处理", 409);
  const b = z
    .object({
      decisions: z
        .array(
          z.object({
            id: z.string(),
            strategy: z.enum([
              "pending",
              "placeholder",
              "pass",
              "env",
              "rewrite",
            ]),
          }),
        )
        .optional(),
      manual: z
        .object({
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        })
        .optional(),
    })
    .parse(req.body);
  const next = r.findings.map((f) => ({ ...f }));
  if (b.manual) {
    const { start, end } = b.manual;
    if (
      end <= start ||
      end > r.original.length ||
      next.some(
        (f) =>
          (start < f.end && end > f.start) ||
          f.value === r.original.slice(start, end),
      )
    )
      throw fail("请选择未标记的原文");
    next.push(
      makeFinding(
        "CUSTOM",
        "手动标记",
        r.original.slice(start, end),
        start,
        end,
        true,
      ),
    );
    next.sort((a, b) => a.start - b.start);
  }
  const decisions = (b.decisions || []).map((d) => {
    const f = next.find((f) => f.id === d.id);
    if (!f) throw fail("标记不存在");
    if (d.strategy === "env" && f.secret)
      throw fail("密钥不能封装为 ENV；请使用占位符或重写。");
    return { f, strategy: d.strategy };
  });
  for (const d of decisions) d.f.strategy = d.strategy;
  r.findings = next;
  r.status = "review";
  r.english = undefined;
  return r;
});
app.post<{ Params: { id: string } }>("/api/reviews/:id/prepare", async (req) =>
  prepare(review(req.params.id)),
);
app.post("/api/messages", async (req) => {
  const b = runOptions
    .extend({
      sessionId: z.string().uuid(),
      prompt: z.string().trim().max(50000),
      mode: z.enum(["automatic", "manual", "direct"]).default("automatic"),
      steering: z.boolean().default(false),
      attachments: z.array(z.string().uuid()).max(12).default([]),
    })
    .parse(req.body);
  const activityId = "input:" + randomUUID();
  store.activities.set(b.sessionId, activityId, "checking", {
    scope: "upstream",
  });
  try {
    if (!b.prompt && !b.attachments.length) throw fail("请输入任务或添加附件");
    if (!b.prompt) b.prompt = "请查看附件。";
    if (b.prompt.startsWith("/")) {
      const command = await runtime.command(b.sessionId, b.prompt);
      if (command.control === "clear") {
        const previous = session(b.sessionId);
        if (busy(previous.repo)) throw fail("请先结束当前任务", 409);
        await runtime.close(previous.id);
        return { session: store.create(previous.repo) };
      }
      if (command.control)
        return {
          control: command.control,
          result: await runtime.control(
            b.sessionId,
            command.control,
            command.args,
          ),
        };
      const r = createReview(
        b.sessionId,
        b.prompt,
        b.mode,
        b.steering,
        b.attachments,
      );
      if (r.findings.length || b.mode === "manual") return { review: r };
      await prepare(r);
      return { runId: (await runtime.start(r, b)).id };
    }
    const r = createReview(
      b.sessionId,
      b.prompt,
      b.mode,
      b.steering,
      b.attachments,
    );
    if (b.mode === "manual" || r.findings.length) return { review: r };
    await prepare(r);
    return { runId: (await runtime.start(r, b)).id };
  } finally {
    store.activities.clear(b.sessionId, activityId);
  }
});
app.post("/api/runs", async (req) => {
  const b = runOptions.extend({ reviewId: z.string().uuid() }).parse(req.body);
  return { id: (await runtime.start(review(b.reviewId), b)).id };
});
app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
  "/api/sessions/:id/capabilities",
  async (req) => runtime.capabilities(req.params.id, req.query.refresh === "1"),
);
app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/control",
  async (req) => {
    const b = z
      .object({
        method: z.string().max(100),
        args: z.array(z.unknown()).max(4).default([]),
      })
      .parse(req.body);
    return { result: await runtime.control(req.params.id, b.method, b.args) };
  },
);
app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/rename",
  async (req) => {
    const b = z
      .object({ title: z.string().trim().min(1).max(100) })
      .parse(req.body);
    const s = session(req.params.id);
    s.title = b.title;
    store.save(s);
    return s;
  },
);
app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
  "/api/runs/:id/events",
  async (req, reply) => {
    const run = runtime.runs.get(req.params.id);
    if (!run) throw fail("运行记录不存在", 404);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const after = Number(req.headers["last-event-id"] || req.query.after || 0);
    const send = (event: import("../shared/types.ts").RunEvent) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (["done", "error"].includes(event.type)) reply.raw.end();
    };
    run.listeners.add(send);
    for (const event of run.events) if (event.seq > after) send(event);
    if (run.done) reply.raw.end();
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15000);
    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      run.listeners.delete(send);
    });
  },
);
app.post<{ Params: { id: string } }>(
  "/api/runs/:id/interrupt",
  async (req) => ({
    ok: true,
    receipt: await runtime.interrupt(req.params.id),
  }),
);
app.get<{ Querystring: { repo: string } }>(
  "/api/sandbox/login",
  async (req) => {
    const repo = repoSchema.parse(req.query.repo);
    return {
      flow: sandboxLogins.get(repo) || null,
      mode: usesWebLogin(repo) ? "web" : "token",
    };
  },
);
app.post("/api/sandbox/login", async (req) => {
  const { repo } = z.object({ repo: repoSchema }).parse(req.body);
  return sandboxLogins.start(repo);
});
app.post("/api/sandbox/login/code", async (req) => {
  const b = z
    .object({
      repo: repoSchema,
      id: z.string().uuid(),
      code: z.string().min(3).max(4096),
    })
    .parse(req.body);
  return sandboxLogins.submit(b.repo, b.id, b.code);
});
app.post("/api/sandbox/login/cancel", async (req) => {
  const { repo } = z.object({ repo: repoSchema }).parse(req.body);
  await sandboxLogins.cancel(repo);
  return { ok: true };
});
app.post("/api/sandbox/login/token", async (req) => {
  const { repo } = z.object({ repo: repoSchema }).parse(req.body);
  if (!config.oauth) throw fail("尚未配置长期 token。");
  return sandboxLogins.tokenMode(repo);
});
app.post<{ Params: { id: string } }>("/api/permissions/:id", async (req) => {
  const b = z
    .object({
      allow: z.boolean(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      content: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        )
        .optional(),
      result: z.record(z.string(), z.unknown()).optional(),
      message: z.string().max(4000).optional(),
    })
    .parse(req.body);
  await runtime.answer(req.params.id, b);
  return { ok: true };
});
app.get<{ Querystring: { repo: string } }>(
  "/api/sandbox/status",
  async (req) => {
    const repo = repoSchema.parse(req.query.repo);
    const status = (await sandbox(`/sandbox/status?repo=${repo}`)) as {
      running?: boolean;
    };
    return {
      ...status,
      authMode: usesWebLogin(repo) ? "web" : "token",
      auth: status.running
        ? await authStatus(repo)
        : {
            loggedIn: false,
            authMethod: "not-checked",
            note: "启动容器后可检查登录状态",
          },
    };
  },
);
app.post("/api/sandbox/action", async (req) => {
  const b = z
    .object({
      repo: repoSchema,
      action: z.enum([
        "start",
        "stop",
        "recreate",
        "network/cut",
        "network/restore",
      ]),
    })
    .parse(req.body);
  if (busy(b.repo) && !b.action.startsWith("network/"))
    throw fail("请先中断正在执行的任务", 409);
  if (sandboxLogins.busy(b.repo) && !b.action.startsWith("network/"))
    throw fail("请先完成或取消网页登录。", 409);
  if (b.action === "stop" || b.action === "recreate")
    for (const s of store.sessions().filter((s) => s.repo === b.repo))
      await runtime.close(s.id);
  const result = await sandbox(`/sandbox/${b.action}`, "POST", {
    repo: b.repo,
  });
  if (b.action.startsWith("network/")) {
    try {
      await gateway(`/${b.action}`, { repo: b.repo });
    } catch {
      throw fail(
        "沙箱网络操作已完成，但发布服务网络未同步，请在 Reports 中停止相关服务。",
        502,
      );
    }
  }
  return result;
});
app.get<{ Querystring: { repo: string } }>(
  "/api/sandbox/usage",
  async (req) => {
    const repo = repoSchema.parse(req.query.repo);
    return {
      repo,
      ...sandboxTokens(
        store.sessions().filter((session) => session.repo === repo),
      ),
    };
  },
);
app.get("/api/volumes", async () => sandbox("/volumes"));
app.post("/api/volumes/backup", async (req) => {
  const b = z.object({ repo: repoSchema, volume: z.string() }).parse(req.body);
  if (![`cc-state-${b.repo}`, `cc-work-${b.repo}`].includes(b.volume))
    throw fail("卷与仓库不匹配");
  if (busy(b.repo)) throw fail("请先结束任务，再停止容器以取得一致备份", 409);
  return sandbox(`/volumes/${encodeURIComponent(b.volume)}/backup`, "POST", {});
});
app.post("/api/volumes/destroy", async (req) => {
  const b = z
    .object({
      repo: repoSchema,
      confirmation: z.string(),
      acknowledge: z.literal(true),
    })
    .parse(req.body);
  if (b.confirmation !== `永久删除 ${b.repo}`) throw fail("确认文字不匹配");
  if (busy(b.repo)) throw fail("请先中断此仓库的任务", 409);
  if (sandboxLogins.busy(b.repo)) throw fail("请先完成或取消网页登录。", 409);
  for (const report of runtime.reports
    .list()
    .filter(
      (report) =>
        report.repo === b.repo &&
        report.kind === "service" &&
        report.state === "running",
    ))
    await runtime.reports.stop(report.id);
  await sandbox("/sandbox/stop", "POST", { repo: b.repo });
  // Never force-delete an in-use volume. A partial failure remains visible to the user.
  for (const volume of [`cc-state-${b.repo}`, `cc-work-${b.repo}`])
    await sandbox(`/volumes/${volume}`, "DELETE");
  for (const s of store.sessions().filter((s) => s.repo === b.repo)) {
    await runtime.close(s.id);
    store.remove(s.id);
  }
  for (const [id, r] of reviews)
    if (!store.session(r.sessionId)) reviews.delete(id);
  await sandboxLogins.forget(b.repo);
  return { ok: true };
});
const housekeeper = setInterval(() => {
  for (const [id, r] of reviews)
    if (
      Date.now() - Date.parse(r.createdAt) > 7200000 &&
      r.status !== "running"
    )
      reviews.delete(id);
  void runtime.housekeep();
  sandboxLogins.housekeep();
  logins.prune();
}, 30000);
housekeeper.unref();
if (existsSync(resolve("dist"))) {
  await app.register(staticFiles, { root: resolve("dist") });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "接口不存在" })
      : reply.sendFile("index.html"),
  );
}
async function shutdown() {
  await sandboxLogins.shutdown();
  await runtime.shutdown();
  clearInterval(housekeeper);
  for (const stream of liveStreams) stream.end();
  await app.close();
  store.close();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
console.log(`Folio API · http://${config.host}:${config.port} · LIVE`);
