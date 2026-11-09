import { createHash, randomUUID } from "node:crypto";
import { posix, join, resolve, dirname, basename } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, parseFragment, serialize, serializeOuter } from "parse5";
import sharp from "sharp";
import { Store } from "./store.ts";
import { SandboxFiles, MAX_ASSET_BYTES, type FileBridge } from "./files.ts";
import { sandbox } from "./sandbox.ts";
import {
  detect,
  maskOutput,
  materialize,
  protect,
  restore,
} from "./privacy.ts";
import {
  recentDialogue,
  translateCatalog,
  translateImage,
} from "./translator.ts";
import type { Asset, Finding } from "../shared/types.ts";
const executeFile = promisify(execFile);
export const HTML_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".css": "text/css",
  ".py": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".xml": "text/plain",
  ".log": "text/plain",
  ".sh": "text/plain",
};
export function fileType(
  name: string,
  bytes: Buffer,
): { mime: string; kind: Asset["kind"] } {
  let mime =
    mimeTypes[posix.extname(name).toLowerCase()] || "application/octet-stream";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mime = "image/jpeg";
  else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString()))
    mime = "image/gif";
  else if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    mime = "image/webp";
  else if (bytes.subarray(0, 2).toString() === "BM") mime = "image/bmp";
  else if (
    bytes.subarray(4, 8).toString() === "ftyp" &&
    ["avif", "avis"].includes(bytes.subarray(8, 12).toString())
  )
    mime = "image/avif";
  else if (bytes.subarray(0, 5).toString() === "%PDF-")
    mime = "application/pdf";
  // A raster filename is not sufficient to make arbitrary bytes an image.
  else if (
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
      "image/avif",
    ].includes(mime)
  )
    throw fail("图片格式与实际内容不匹配");
  return {
    mime,
    kind: mime.startsWith("image/")
      ? "image"
      : mime === "text/html"
        ? "html"
        : mime === "application/pdf"
          ? "pdf"
          : mime.startsWith("text/") || mime === "application/json"
            ? "text"
            : "file",
  };
}
export function inputPath(asset: Asset) {
  const ext =
    posix
      .extname(asset.name)
      .replace(/[^.a-zA-Z0-9]/g, "")
      .slice(0, 12) || ".bin";
  return `/work/.folio/inputs/${asset.id}/v${asset.revision}/input${ext.toLowerCase()}`;
}
const attr = (node: any, name: string) =>
  node.attrs?.find((a: any) => a.name === name)?.value;
const setAttr = (node: any, name: string, value: string) => {
  node.attrs ||= [];
  const a = node.attrs.find((x: any) => x.name === name);
  if (a) a.value = value;
  else node.attrs.push({ name, value });
};
function visit(node: any, fn: (node: any) => void) {
  fn(node);
  for (const child of [...(node.childNodes || [])]) visit(child, fn);
}
function detach(node: any) {
  if (node.parentNode)
    node.parentNode.childNodes = node.parentNode.childNodes.filter(
      (n: any) => n !== node,
    );
}
const textNode = (value: string) => ({ nodeName: "#text", value });
export function pageCatalog(source: string) {
  let catalog: Record<string, string> | undefined;
  const document = parse(source);
  visit(document, (node) => {
    if (
      node.tagName === "script" &&
      attr(node, "id") === "folio-i18n" &&
      attr(node, "type") === "application/json"
    ) {
      const value = JSON.parse(
        (node.childNodes || []).map((n: any) => n.value || "").join(""),
      );
      if (
        !value ||
        Array.isArray(value) ||
        Object.keys(value).length > 500 ||
        Object.values(value).some((v) => typeof v !== "string") ||
        JSON.stringify(value).length > 100000
      )
        throw fail("页面本地化字典需为不超过 500 项的扁平字符串对象");
      catalog = value;
    }
  });
  if (!catalog || !Object.keys(catalog).length)
    throw fail(
      'HTML 需要 <script id="folio-i18n" type="application/json"> 字典，并用 data-i18n 标记可翻译文本。请按本地化页面规范重新发布。',
    );
  return catalog;
}
export function localizeInline(source: string) {
  if (/id\s*=\s*["']folio-i18n["']/i.test(source))
    return { html: source, catalog: pageCatalog(source) };
  const document = parse(source),
    catalog: Record<string, string> = {};
  const key = (value: string) => {
    if (Object.keys(catalog).length >= 500)
      throw fail("片段可翻译文本超过 500 项，请使用独立页面。");
    const id = "text_" + Object.keys(catalog).length;
    catalog[id] = value;
    return id;
  };
  const nodes: any[] = [];
  visit(document, (n) => nodes.push(n));
  for (const node of nodes) {
    let parent = node.parentNode,
      skip = false;
    for (let at = parent; at; at = at.parentNode)
      if (
        ["script", "style", "pre", "code", "svg", "math"].includes(at.tagName)
      )
        skip = true;
    if (skip) continue;
    if (node.tagName)
      for (const name of ["title", "placeholder", "aria-label", "alt"]) {
        const value = attr(node, name);
        if (value?.trim()) setAttr(node, "data-i18n-" + name, key(value));
      }
    if (node.nodeName !== "#text" || !node.value?.trim() || !parent?.tagName)
      continue;
    const id = key(node.value);
    if (["title", "option", "textarea"].includes(parent.tagName)) {
      setAttr(parent, "data-i18n", id);
      continue;
    }
    const span: any = {
      nodeName: "span",
      tagName: "span",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      attrs: [{ name: "data-i18n", value: id }],
      childNodes: [node],
      parentNode: parent,
    };
    parent.childNodes[parent.childNodes.indexOf(node)] = span;
    node.parentNode = span;
  }
  return { html: serialize(document), catalog };
}
export function svgForRaster(source: string) {
  const tree = parseFragment(source);
  visit(tree, (node: any) => {
    if (["script", "foreignObject"].includes(node.tagName)) detach(node);
    if (
      node.tagName === "style" &&
      /url\s*\(|@import/i.test(
        (node.childNodes || []).map((n: any) => n.value || "").join(""),
      )
    )
      detach(node);
    node.attrs = node.attrs?.filter(
      (a: any) =>
        !/^on/i.test(a.name) &&
        !(a.name === "style" && /url\s*\(|@import/i.test(a.value)) &&
        !(
          ["href", "src"].includes(a.name) &&
          !a.value.startsWith("#") &&
          !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(a.value)
        ),
    );
  });
  return serialize(tree);
}
export const PAGE_CONTRACT = `Use mcp__folio__publish_file to present generated files or images. Proactively use mcp__folio__publish_service for reports, interactive demos and web apps, and include the returned URL in your reply. For static sites, build first and provide a /work/ file or build directory containing index.html. For services, provide command, cwd and port; bind to 0.0.0.0:$PORT. The service has read-only /work and writable /tmp, without your credentials or session state; prepare dependencies first. Use relative asset, API and WebSocket URLs and bundled JavaScript so the app works under a URL prefix. Remote resources, workers and browser storage are unavailable. Services expire after 120 minutes unless ttlMinutes is supplied (maximum 1440).`;

export class MediaService {
  private jobs = new Map<string, Promise<Asset>>();
  private controller = new AbortController();
  private imageTail: Promise<unknown> = Promise.resolve();
  private inlineJobs = new Map<string, Promise<Asset>>();

  constructor(
    public store: Store,
    public bridge: FileBridge = new SandboxFiles(),
  ) {}
  get(id: string, sessionId?: string) {
    const asset = this.store.asset(id);
    if (!asset || (sessionId && asset.sessionId !== sessionId))
      throw fail("附件不存在或不属于当前会话", 404);
    return asset;
  }
  inline(
    sessionId: string,
    kind: "html" | "svg" | "image",
    source: string,
  ): Promise<Asset> {
    const key = digest(Buffer.from(kind + "\0" + source)),
      cacheKey = sessionId + ":" + key;
    const existing = this.store
      .assets(sessionId)
      .find((a) => a.inlineKey === key);
    if (existing) return Promise.resolve(existing);
    if (this.inlineJobs.has(cacheKey)) return this.inlineJobs.get(cacheKey)!;
    const job = this.createInline(sessionId, kind, source, key).catch(
      (error) => {
        this.inlineJobs.delete(cacheKey);
        throw error;
      },
    );
    this.inlineJobs.set(cacheKey, job);
    if (this.inlineJobs.size > 200)
      this.inlineJobs.delete(this.inlineJobs.keys().next().value!);
    return job;
  }
  private async createInline(
    sessionId: string,
    kind: "html" | "svg" | "image",
    source: string,
    key: string,
  ) {
    const session = this.store.session(sessionId);
    if (!session) throw fail("会话不存在", 404);
    if (kind === "image") {
      const data =
        /^data:(image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml))((?:;[^,]*)?),(.*)$/is.exec(
          source,
        );
      if (data) {
        const bytes = /;base64/i.test(data[2])
          ? Buffer.from(data[3], "base64")
          : Buffer.from(decodeURIComponent(data[3]));
        const same = this.store
          .assets(sessionId)
          .find((a) => a.kind === "image" && a.digest === digest(bytes));
        if (same) return same;
        const extension =
          data[1] === "image/svg+xml" ? "svg" : data[1].slice(6);
        const asset = this.register(
          sessionId,
          "inline-" + key.slice(0, 12) + "." + extension,
          bytes,
          "output",
          { inlineKey: key },
        );
        this.schedule(asset.id);
        return asset;
      }
      const id = /^folio-asset:\/\/([a-f0-9-]{36})$/i.exec(source)?.[1];
      if (id) return this.get(id, sessionId);
      let path = source.startsWith("file:") ? new URL(source).pathname : source;
      try {
        path = decodeURIComponent(path);
      } catch {
        throw fail("图片路径编码无效");
      }
      path = posix.resolve("/work", path);
      if (!path.startsWith("/work/")) throw fail("只能显示当前工作区图片");
      const saved = this.store
        .assets(sessionId)
        .find(
          (a) =>
            a.kind === "image" && [a.sourcePath, a.sandboxPath].includes(path),
        );
      if (saved) return saved;
      await sandbox("/sandbox/start", "POST", { repo: session.repo });
      const bytes = await this.bridge.read(session.repo, path);
      if (fileType(path, bytes).kind !== "image") throw fail("此路径不是图片");
      const identical = this.store
        .assets(sessionId)
        .find((a) => a.kind === "image" && a.digest === digest(bytes));
      if (identical) return identical;
      const asset = this.register(
        sessionId,
        posix.basename(path),
        bytes,
        "output",
        { sourcePath: path, inlineKey: key },
      );
      this.schedule(asset.id);
      return asset;
    }
    const name =
      "inline-" + key.slice(0, 12) + (kind === "svg" ? ".svg" : ".html");
    if (kind === "svg") {
      const tree = parseFragment(source) as any,
        root = tree.childNodes.find((n: any) => n.tagName === "svg");
      if (!root) throw fail("SVG 片段无效");
      if (!attr(root, "xmlns"))
        setAttr(root, "xmlns", "http://www.w3.org/2000/svg");
      source = serializeOuter(root);
      const same = this.store
        .assets(sessionId)
        .find(
          (a) => a.kind === "image" && a.digest === digest(Buffer.from(source)),
        );
      if (same) return same;
      const asset = this.register(
        sessionId,
        name,
        Buffer.from(source),
        "output",
        { inlineKey: key, title: "SVG 图形" },
      );
      this.schedule(asset.id);
      return asset;
    }
    const localized = localizeInline(source),
      bundled = await this.bundleHtml(
        sessionId,
        "/work/__folio_inline__.html",
        localized.html,
      );
    const asset = this.register(
      sessionId,
      name,
      Buffer.from(source),
      "output",
      {
        inlineKey: key,
        title: "HTML 片段",
        catalog: localized.catalog,
        children: bundled.children,
      },
    );
    this.store.writeDerivative(asset.id, Buffer.from(bundled.html));
    asset.previewReady = true;
    this.store.saveAsset(asset);
    this.schedule(asset.id);
    return asset;
  }
  private register(
    sessionId: string,
    name: string,
    bytes: Buffer,
    origin: Asset["origin"],
    extra: Partial<Asset> = {},
  ) {
    if (!this.store.session(sessionId)) throw fail("会话不存在", 404);
    if (bytes.length > MAX_ASSET_BYTES)
      throw fail("单个附件不能超过 25 MB", 413);
    name =
      posix
        .basename(name.replace(/\\/g, "/"))
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 180) || "file";
    const type = fileType(name, bytes);
    const asset: Asset = {
      id: randomUUID(),
      sessionId,
      name,
      size: bytes.length,
      digest: digest(bytes),
      createdAt: new Date().toISOString(),
      origin,
      ...type,
      approval: "ready",
      scan: origin === "upload" && type.kind === "image" ? "exempt" : "clean",
      revision: 1,
      translationState: "none",
      ...extra,
    };
    if (origin === "upload" && type.kind !== "image") {
      if (type.kind === "text" || type.kind === "html") {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.length > 2000000) throw new Error("large");
          asset.findings = detect(text);
          asset.scan = asset.findings.length ? "findings" : "clean";
          asset.approval = asset.findings.length ? "pending" : "ready";
        } catch {
          asset.scan = "unscanned";
          asset.approval = "pending";
        }
      } else {
        asset.scan = "unscanned";
        asset.approval = "pending";
      }
    }
    return this.store.writeAsset(asset, bytes);
  }
  upload(sessionId: string, name: string, bytes: Buffer) {
    return this.register(sessionId, name, bytes, "upload");
  }
  decide(
    id: string,
    decisions: { id: string; strategy: "pass" | "placeholder" }[] = [],
    allowUnscanned = false,
  ) {
    const asset = this.get(id);
    if (asset.origin !== "upload" || asset.kind === "image")
      throw fail("此附件不需要隐私处理");
    if (asset.scan === "unscanned" && !allowUnscanned)
      throw fail("请明确选择原样发送未扫描文件");
    for (const decision of decisions) {
      const f = asset.findings?.find((f) => f.id === decision.id);
      if (!f) throw fail("文件标记不存在");
      f.strategy = decision.strategy;
    }
    if (asset.findings?.some((f) => f.strategy === "pending"))
      throw fail("请处理文件中的全部敏感标记");
    asset.approval = "ready";
    asset.revision++;
    asset.sandboxPath = undefined;
    return this.store.saveAsset(asset);
  }
  validate(sessionId: string, ids: string[] = []) {
    if (ids.length > 12 || new Set(ids).size !== ids.length)
      throw fail("每条消息最多附带 12 个不同文件");
    return ids.map((id) => {
      const a = this.get(id, sessionId);
      if (a.approval !== "ready")
        throw fail(`请先处理附件「${a.name}」的隐私选择。`);
      return a;
    });
  }
  references(prompt: string, assets: Asset[]) {
    let text = prompt;
    const tokens = new Map<string, string>();
    for (const a of assets) {
      const token = `__YJ_FILE_${a.id.replaceAll("-", "").toUpperCase()}__`;
      const path = "`" + inputPath(a) + "`";
      for (const ref of ["@[" + a.name + "]", "@" + a.name])
        if (text.includes(ref)) {
          text = text.split(ref).join(token);
          tokens.set(token, path);
        }
    }
    return {
      text,
      restore: (s: string) => {
        for (const [token, path] of tokens) s = s.split(token).join(path);
        return s;
      },
    };
  }
  async prepareInputs(
    sessionId: string,
    ids: string[] = [],
    versions?: Record<string, number>,
  ) {
    const assets = this.validate(sessionId, ids),
      session = this.store.session(sessionId)!;
    if (versions && assets.some((a) => versions[a.id] !== a.revision))
      throw fail("附件隐私选择已变化，请重新检查并发送。", 409);
    if (!assets.length) return [];
    await sandbox("/sandbox/start", "POST", { repo: session.repo });
    for (const asset of assets) {
      let bytes = this.store.assetBytes(asset.id);
      if (asset.kind !== "image" && asset.findings?.length) {
        bytes = Buffer.from(
          materialize(
            protect(bytes.toString("utf8"), asset.findings),
            asset.findings,
          ),
        );
        this.store.bind(sessionId, asset.findings);
      }
      const path = inputPath(asset);
      await this.bridge.write(session.repo, path, bytes);
      asset.sandboxPath = path;
      this.store.saveAsset(asset);
    }
    return assets;
  }
  async messageContent(
    sessionId: string,
    text: string,
    ids: string[] = [],
    versions?: Record<string, number>,
  ) {
    const assets = await this.prepareInputs(sessionId, ids, versions);
    if (!assets.length) return text;
    const manifest = assets
      .map(
        (a, i) =>
          `${i + 1}. ${a.kind === "image" ? "Image" : "File"}: ${a.sandboxPath}`,
      )
      .join("\n");
    const content: any[] = [
      {
        type: "text",
        text:
          text +
          "\n\nAttached files in the current sandbox (use Read when needed):\n" +
          manifest,
      },
    ];
    for (const a of assets)
      if (
        a.kind === "image" &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          a.mime,
        ) &&
        a.size <= 4 * 1024 * 1024
      )
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: a.mime,
            data: this.store.assetBytes(a.id).toString("base64"),
          },
        });
    return content;
  }
  async publish(
    sessionId: string,
    runId: string,
    path: string,
    title?: string,
  ) {
    const session = this.store.session(sessionId);
    if (!session) throw fail("会话不存在", 404);
    path = posix.normalize(path);
    if (!path.startsWith("/work/")) throw fail("产物只能来自当前 /work 工作区");
    const bytes = await this.bridge.read(session.repo, path),
      name = posix.basename(path),
      type = fileType(name, bytes);
    // Reusing an uploaded image never sends its bytes to translation.
    const existing = this.store
      .assets(sessionId)
      .find((a) => a.digest === digest(bytes) && a.kind === "image");
    if (existing) {
      existing.publishedRuns = [
        ...new Set([...(existing.publishedRuns || []), runId]),
      ];
      existing.title = title || existing.name;
      return this.store.saveAsset(existing);
    }
    let catalog: Record<string, string> | undefined,
      preview: Buffer | undefined,
      children: string[] = [];
    if (type.kind === "html") {
      const localized = localizeInline(bytes.toString("utf8"));
      catalog = localized.catalog;
      const bundled = await this.bundleHtml(sessionId, path, localized.html);
      preview = Buffer.from(bundled.html);
      children = bundled.children;
    }
    const asset = this.register(sessionId, name, bytes, "output", {
      sourcePath: path,
      title: title?.slice(0, 120) || name,
      publishedRuns: [runId],
      catalog,
      children,
    });
    if (preview) {
      this.store.writeDerivative(asset.id, preview);
      asset.previewReady = true;
      this.store.saveAsset(asset);
    }
    this.schedule(asset.id);
    return asset;
  }
  outputImage(sessionId: string, runId: string, bytes: Buffer, mime: string) {
    const name =
      "image-" +
      randomUUID().slice(0, 8) +
      (mime === "image/jpeg"
        ? ".jpg"
        : mime === "image/webp"
          ? ".webp"
          : ".png");
    const existing = this.store
      .assets(sessionId)
      .find((a) => a.kind === "image" && a.digest === digest(bytes));
    const asset = existing || this.register(sessionId, name, bytes, "output");
    asset.publishedRuns = [...new Set([...(asset.publishedRuns || []), runId])];
    this.store.saveAsset(asset);
    if (asset.origin === "output") this.schedule(asset.id);
    return asset;
  }
  private async bundleHtml(sessionId: string, path: string, source: string) {
    const document = parse(source),
      children: string[] = [],
      repo = this.store.session(sessionId)!.repo;
    let budget = Buffer.byteLength(source),
      workspaceReady = false;
    const read = async (reference: string, base = path) => {
      if (reference.startsWith("data:"))
        return { bytes: Buffer.from([]), mime: "", data: reference };
      if (/^[a-z]+:/i.test(reference) || reference.startsWith("//"))
        throw fail("HTML 预览需要本地资源；请将远程依赖保存到工作区或内联。");
      const clean = reference.split(/[?#]/)[0],
        target = posix.resolve(posix.dirname(base), clean);
      if (!target.startsWith("/work/")) throw fail("页面依赖超出了当前工作区");
      if (!workspaceReady) {
        await sandbox("/sandbox/start", "POST", { repo });
        workspaceReady = true;
      }
      const bytes = await this.bridge.read(repo, target);
      budget += bytes.length;
      if (budget > 30 * 1024 * 1024) throw fail("页面及依赖总计不能超过 30 MB");
      const mime = fileType(target, bytes).mime;
      return {
        bytes,
        mime,
        data: `data:${mime};base64,${bytes.toString("base64")}`,
      };
    };
    const cssBases = new Map<any, string>();
    const nodes: any[] = [];
    visit(document, (n) => nodes.push(n));
    for (const node of nodes) {
      if (
        node.tagName === "base" ||
        (node.tagName === "meta" &&
          /refresh/i.test(attr(node, "http-equiv") || ""))
      ) {
        detach(node);
        continue;
      }
      if (node.tagName === "img" && attr(node, "src")) {
        const ref = attr(node, "src")!,
          resource = await read(ref);
        setAttr(node, "src", resource.data);
        node.attrs = node.attrs.filter(
          (a: any) =>
            !["srcset", "crossorigin", "referrerpolicy"].includes(a.name),
        );
        if (resource.bytes.length) {
          let child = this.store
            .assets(sessionId)
            .find(
              (a) => a.kind === "image" && a.digest === digest(resource.bytes),
            );
          child ||= this.register(
            sessionId,
            posix.basename(ref.split(/[?#]/)[0]),
            resource.bytes,
            "output",
            { description: attr(node, "alt") || "" },
          );
          children.push(child.id);
          setAttr(node, "data-folio-asset", child.id);
          if (child.origin === "output") this.schedule(child.id);
        }
      }
      if (node.tagName === "script" && attr(node, "src")) {
        const resource = await read(attr(node, "src")!);
        if (!resource.bytes.length)
          throw fail("请将页面脚本内联或保存为本地文件");
        node.attrs = node.attrs.filter((a: any) => a.name !== "src");
        node.childNodes = [
          textNode(
            resource.bytes
              .toString("utf8")
              .replace(/<\/script/gi, "<\\/script"),
          ),
        ];
      }
      if (
        node.tagName === "link" &&
        /stylesheet/i.test(attr(node, "rel") || "") &&
        attr(node, "href")
      ) {
        const reference = attr(node, "href")!;
        const resource = await read(reference);
        cssBases.set(node, posix.resolve(posix.dirname(path), reference));
        node.tagName = "style";
        node.nodeName = "style";
        node.attrs = [];
        node.childNodes = [textNode(resource.bytes.toString("utf8"))];
      }
    }
    // Inline local CSS url() resources as well; data URLs stay self-contained.
    for (const node of nodes.filter((n) => n.tagName === "style")) {
      let css = (node.childNodes || []).map((n: any) => n.value || "").join("");
      for (const match of [
        ...css.matchAll(/url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/g),
      ]) {
        if (match[1].startsWith("data:") || match[1].startsWith("#")) continue;
        const resource = await read(match[1], cssBases.get(node) || path);
        css = css.replace(match[0], `url("${resource.data}")`);
      }
      node.childNodes = [textNode(css)];
    }
    return { html: serialize(document), children: [...new Set(children)] };
  }
  private context(sessionId: string) {
    const bindings = this.store.bindings(sessionId),
      messages = this.store.visibleMessages(sessionId);
    return {
      bindings,
      history: recentDialogue(messages, bindings),
      request: maskOutput(
        [...messages].reverse().find((m) => m.role === "user")?.chinese || "",
        bindings,
      ),
    };
  }
  schedule(id: string) {
    const asset = this.get(id);
    if (asset.origin === "upload" || !["html", "image"].includes(asset.kind))
      return;
    const mode =
      this.store.session(asset.sessionId)?.downstreamMode || "messages";
    if (mode !== "manual") void this.translate(id).catch(() => {});
  }
  translate(id: string): Promise<Asset> {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const asset = this.get(id);
    if (asset.origin === "upload")
      return Promise.reject(fail("上传附件不进入翻译服务。"));
    if (asset.translationState !== "done")
      this.store.activities.set(
        asset.sessionId,
        "asset-translate:" + id,
        "translation_queued",
        {
          scope: "downstream",
          detail: asset.kind === "image" ? "图片" : "页面",
        },
      );
    asset.translationState =
      asset.translationState === "done" ? "done" : "pending";
    this.store.saveAsset(asset);
    const operation =
      asset.kind === "image"
        ? this.imageTail.catch(() => {}).then(() => this.translateAsset(id))
        : this.translateAsset(id);
    const job = operation.finally(() => this.jobs.delete(id));
    if (asset.kind === "image") this.imageTail = job.catch(() => {});
    this.jobs.set(id, job);
    return job;
  }
  private async translateAsset(id: string) {
    let asset = this.get(id);
    if (asset.origin === "upload" && asset.kind === "image")
      throw fail("上传图片按原图发送，不做翻译。");
    if (asset.translationState === "done") return asset;
    this.store.activities.set(
      asset.sessionId,
      "asset-translate:" + id,
      "preparing_output",
      { scope: "downstream", detail: asset.kind === "image" ? "图片" : "页面" },
    );
    asset.translationState = "pending";
    asset.translationError = undefined;
    this.store.saveAsset(asset);
    try {
      this.controller.signal.throwIfAborted();
      if (asset.kind === "html") {
        if (!asset.catalog) throw fail("页面没有可翻译的本地化字典");
        if (!Object.keys(asset.catalog).length) {
          asset.translatedCatalog = {};
          asset.translationState = "done";
          return this.store.saveAsset(asset);
        }
        const serialized = JSON.stringify(asset.catalog),
          known = this.store.bindings(asset.sessionId),
          found = detect(serialized).filter(
            (f) => !known.some((b) => b.value === f.value),
          );
        if (found.length) this.store.bind(asset.sessionId, found);
        const { bindings, history, request } = this.context(asset.sessionId);
        if (Object.keys(asset.catalog).some((k) => detect(k).length))
          throw fail("本地化字典的键包含敏感内容，请改用普通标识符。");
        const masked = Object.fromEntries(
          Object.entries(asset.catalog).map(([k, v]) => [
            k,
            maskOutput(v, bindings),
          ]),
        );
        this.store.activities.set(
          asset.sessionId,
          "asset-translate:" + id,
          "translating",
          { scope: "downstream", detail: "页面" },
        );
        const translated = await translateCatalog(
          masked,
          history,
          request,
          this.controller.signal,
        );
        asset = this.get(id);
        asset.translatedCatalog = Object.fromEntries(
          Object.entries(translated).map(([k, v]) => [k, restore(v, bindings)]),
        );
      } else if (asset.kind === "image") {
        const safe = await this.privateOutputImage(asset);
        if (safe.findings.length)
          this.store.bind(asset.sessionId, safe.findings);
        const { bindings, history } = this.context(asset.sessionId);
        this.store.activities.set(
          asset.sessionId,
          "asset-translate:" + id,
          "translating",
          { scope: "downstream", detail: "图片说明" },
        );
        const result = await translateImage(
          safe.image,
          safe.mime,
          maskOutput(asset.description || asset.title || asset.name, bindings),
          history,
          this.controller.signal,
        );
        asset = this.get(id);
        asset.description = result.description_en;
        asset.descriptionZh = restore(result.description_zh, bindings);
      } else throw fail("此文件通过内容预览或下载查看");
      asset.translationState = "done";
      return this.store.saveAsset(asset);
    } catch (error) {
      asset = this.get(id);
      asset.translationState = "error";
      asset.translationError = (error as Error).message;
      this.store.saveAsset(asset);
      throw error;
    } finally {
      this.store.activities.clear(asset.sessionId, "asset-translate:" + id);
    }
  }
  private async privateOutputImage(asset: Asset) {
    // Uploaded images never enter this path. OCR and masking apply only to
    // model-produced images before their optional external vision translation.
    const bytes = this.store.assetBytes(asset.id);
    const image = await sharp(
      asset.mime === "image/svg+xml"
        ? Buffer.from(svgForRaster(bytes.toString("utf8")))
        : bytes,
      {
        limitInputPixels: 30000000,
      },
    )
      .resize({
        width: 1800,
        height: 1800,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const directory = await mkdtemp(join(this.store.directory, "image-"));
    try {
      const file = join(directory, "output.png");
      await writeFile(file, image, { mode: 0o600 });
      const { stdout } = await executeFile(
        process.env.OCR_COMMAND || "tesseract",
        [file, "stdout", "-l", "eng", "tsv"],
        { timeout: 15000, maxBuffer: 3 * 1024 * 1024, windowsHide: true },
      );
      const words: {
        text: string;
        x: number;
        y: number;
        w: number;
        h: number;
        start: number;
        end: number;
      }[] = [];
      let combined = "";
      for (const line of stdout.split("\n").slice(1)) {
        const c = line.split("\t"),
          text = c.slice(11).join("\t").trim();
        if (c.length < 12 || !text) continue;
        const start = combined.length;
        combined += text + " ";
        words.push({
          text,
          x: Number(c[6]),
          y: Number(c[7]),
          w: Number(c[8]),
          h: Number(c[9]),
          start,
          end: start + text.length,
        });
      }
      const known = this.store.bindings(asset.sessionId),
        findings = detect(combined).filter(
          (f) => !known.some((b) => b.value === f.value),
        );
      const regions = [
        ...findings,
        ...known.flatMap((f) => {
          const positions: Finding[] = [];
          let at = combined.indexOf(f.value);
          while (at >= 0) {
            positions.push({ ...f, start: at, end: at + f.value.length });
            at = combined.indexOf(f.value, at + f.value.length);
          }
          return positions;
        }),
      ];
      const boxes = words.filter((word) =>
        regions.some((f) => word.start < f.end && word.end > f.start),
      );
      if (!boxes.length) return { image, mime: "image/png", findings };
      const metadata = await sharp(image).metadata();
      const svg = `<svg width="${metadata.width}" height="${metadata.height}">${boxes
        .filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite))
        .map(
          (b) =>
            `<rect x="${Math.max(0, b.x - 2)}" y="${Math.max(0, b.y - 2)}" width="${b.w + 4}" height="${b.h + 4}" fill="black"/>`,
        )
        .join("")}</svg>`;
      return {
        image: await sharp(image)
          .composite([{ input: Buffer.from(svg) }])
          .png()
          .toBuffer(),
        mime: "image/png",
        findings,
      };
    } catch (error) {
      throw fail(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "输出图片翻译需要服务器 OCR 组件。"
          : "输出图片的本地隐私处理失败，未发送给翻译服务。",
      );
    } finally {
      if (
        dirname(resolve(directory)) !== resolve(this.store.directory) ||
        !basename(directory).startsWith("image-")
      )
        throw new Error("临时目录路径无效");
      await rm(directory, { recursive: true, force: true });
    }
  }
  async shutdown() {
    this.controller.abort();
    await Promise.allSettled([
      ...this.jobs.values(),
      ...this.inlineJobs.values(),
    ]);
    this.inlineJobs.clear();
    this.controller = new AbortController();
  }
}

function scriptJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
export function previewHtml(
  source: string,
  catalog: Record<string, string>,
  translated: Record<string, string> | undefined,
  locale: "en" | "zh",
  descriptions: Record<string, string>,
) {
  const bootstrap = `(()=>{const original=${scriptJson(catalog)},zh=${scriptJson(translated || {})};let language=${scriptJson(locale)};const descriptions=${scriptJson(descriptions)};const t=k=>(language==='zh'?zh[k]:undefined)??original[k]??k;window.folioI18n={t,get language(){return language}};function apply(){document.documentElement.lang=language==='zh'?'zh-CN':'en';document.querySelectorAll('[data-i18n]').forEach(el=>{const key=el.getAttribute('data-i18n');if(Object.prototype.hasOwnProperty.call(original,key))el.textContent=t(key)});for(const attr of ['title','placeholder','aria-label','alt'])document.querySelectorAll('[data-i18n-'+attr+']').forEach(el=>el.setAttribute(attr,t(el.getAttribute('data-i18n-'+attr))));document.querySelectorAll('img[data-folio-asset]').forEach(el=>{const description=descriptions[el.getAttribute('data-folio-asset')];if(description){el.title=description;el.alt=description}});window.dispatchEvent(new CustomEvent('folio-language',{detail:{language}}))}document.addEventListener('DOMContentLoaded',apply);if(document.readyState!=='loading')apply();window.addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='folio-locale')return;if(event.data.locale==='en'||event.data.locale==='zh')language=event.data.locale;if(event.data.dictionary&&typeof event.data.dictionary==='object')for(const [k,v]of Object.entries(event.data.dictionary))if(typeof v==='string'&&Object.prototype.hasOwnProperty.call(original,k))zh[k]=v;if(event.data.descriptions)for(const [k,v]of Object.entries(event.data.descriptions))if(typeof v==='string')descriptions[k]=v;apply()});})();`;
  const sizing = `(()=>{let scheduled=false,last=0;const measure=()=>{scheduled=false;if(!document.body)return;const body=document.body,box=body.getBoundingClientRect(),style=getComputedStyle(body);const size=Math.abs(box.height-innerHeight)<1?innerHeight:Math.max(body.scrollHeight,box.height)+(parseFloat(style.marginTop)||0)+(parseFloat(style.marginBottom)||0);const height=Math.max(40,Math.min(2000,Math.ceil(size)));if(height!==last){last=height;parent.postMessage({type:'folio-preview-size',height},'*')}};const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(measure)}};const start=()=>{new ResizeObserver(schedule).observe(document.body);schedule()};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();window.addEventListener('load',schedule);window.addEventListener('folio-language',schedule)})();`;
  const document = parse(source);
  let head: any;
  visit(document, (node) => {
    if (node.tagName === "head") head = node;
  });
  const injected = parse(`<script>${bootstrap}${sizing}</script>`);
  let script: any;
  visit(injected, (n) => {
    if (n.tagName === "script") script = n;
  });
  if (head && script) {
    script.parentNode = head;
    head.childNodes.unshift(script);
  }
  return serialize(document);
}
