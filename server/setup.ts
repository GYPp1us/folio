import type { FastifyInstance } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { config, hasPassword, persistConfig } from "./config.ts";
import { hashPassword } from "./settings.ts";
import { sandbox } from "./sandbox.ts";
import type { Store } from "./store.ts";
import { thinkingOff } from "./translator.ts";
import { LOGIN_SECONDS, type LoginRegistry } from "./logins.ts";

const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
const version: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const instanceId = randomBytes(12).toString("hex");
const buildPath = new URL("../dist/build.json", import.meta.url);
const build: string | undefined = existsSync(buildPath)
  ? JSON.parse(readFileSync(buildPath, "utf8")).build
  : undefined;
const connectionSchema = z.object({
  oauthToken: z.string().max(8192).optional(),
  translatorUrl: z.string().max(2048).url().or(z.literal("")),
  translatorModel: z.string().trim().min(1).max(128),
  translatorProtocol: z
    .enum(["auto", "openai", "thinking", "qwen", "off"])
    .optional(),
  translatorKey: z.string().max(8192).optional(),
});
export function registerSetup(
  app: FastifyInstance,
  store: Store,
  logins: LoginRegistry,
) {
  const attempts = new Map<string, { count: number; time: number }>();
  const validCookie = (cookies: Record<string, string | undefined>) =>
    (logins.get(cookies.folio_session || "") || 0) > Date.now();
  app.get("/api/health", async () => ({
    service: "folio",
    ok: true,
    version,
    instance: instanceId,
    build,
  }));
  app.get("/api/setup/status", async (req) => {
    const unlocked =
      validCookie(req.cookies) || (!config.setupToken && !hasPassword());
    return {
      required: !config.setupComplete,
      needsInstallCode: !!config.setupToken && !config.setupComplete,
      unlocked,
      defaults: unlocked
        ? {
            oauthConfigured: !!config.oauth,
            translatorUrl: config.translateUrl,
            translatorModel: config.translateModel,
            translatorProtocol: config.translatorProtocol,
            translatorKeyConfigured: !!config.translateKey,
            sandboxUrl: config.sandboxUrl,
            sandboxConfigured: !!config.token,
            retentionDays: config.retentionDays,
            repo: config.defaultRepo,
          }
        : undefined,
    };
  });
  app.post("/api/setup/unlock", async (req, reply) => {
    if (config.setupComplete)
      throw fail("初始化已经完成，请使用访问密码登录", 409);
    if (!config.setupToken) return { ok: true };
    const a = attempts.get(req.ip);
    if (a && a.count >= 8 && Date.now() - a.time < 600000)
      throw fail("尝试过于频繁，请十分钟后再试", 429);
    const { code } = z
      .object({ code: z.string().min(1).max(512) })
      .parse(req.body);
    const digest = (value: string) =>
      createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(code), digest(config.setupToken))) {
      attempts.set(req.ip, { count: (a?.count || 0) + 1, time: Date.now() });
      throw fail("安装码不正确", 401);
    }
    attempts.delete(req.ip);
    const cookie = randomBytes(32).toString("hex");
    logins.set(cookie, Date.now() + 3600000);
    reply.setCookie("folio_session", cookie, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: req.protocol === "https",
      maxAge: 3600,
    });
    return { ok: true };
  });
  app.post("/api/setup/check", async (req) => {
    const b = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("sandbox") }),
        connectionSchema.extend({ kind: z.literal("translator") }),
      ])
      .parse(req.body);
    if (b.kind === "sandbox") {
      const image = await sandbox("/sandbox/image/status");
      return {
        ok: true,
        message: "沙箱服务与镜像已连接。不会启动容器或请求 Claude 模型。",
        detail: image,
      };
    }
    const url = b.translatorUrl || config.translateUrl;
    if (!url || !["https:", "http:"].includes(new URL(url).protocol))
      throw fail("请填写 HTTP(S) 翻译接口地址");
    const key = b.translatorKey || config.translateKey;
    const response = await fetch(url.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: b.translatorModel,
        ...thinkingOff(
          b.translatorModel,
          b.translatorProtocol || config.translatorProtocol,
          b.translatorUrl,
        ),
        temperature: 0,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "Translate into English. Preserve __YJ_TEST_ABC__ exactly. Return only the translation.",
          },
          { role: "user", content: "你好 __YJ_TEST_ABC__" },
        ],
      }),
    });
    if (!response.ok) throw fail(`翻译连接测试返回 HTTP ${response.status}`);
    const result = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const translated = result.choices?.[0]?.message?.content || "";
    if (
      !translated.includes("__YJ_TEST_ABC__") ||
      /\p{Script=Han}/u.test(translated)
    )
      throw fail("服务可达，但测试译文或占位符校验未通过。请调整模型。");
    return { ok: true, message: "翻译连接与占位符保留测试通过。" };
  });
  app.post("/api/setup/complete", async (req, reply) => {
    if (config.setupComplete) throw fail("初始化已经完成", 409);
    const b = connectionSchema
      .extend({
        password: z.string().min(12).max(256),
        retentionDays: z.number().int().min(1).max(730),
        repo: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
      })
      .parse(req.body);
    if (
      !(b.oauthToken || config.oauth) ||
      !(b.translatorUrl || config.translateUrl) ||
      !config.token
    )
      throw fail("请配置 Claude token、翻译接口和服务器沙箱连接。");
    if (
      b.translatorUrl &&
      !["http:", "https:"].includes(new URL(b.translatorUrl).protocol)
    )
      throw fail("翻译接口只支持 HTTP(S)");
    const passwordHash = await hashPassword(b.password);
    // Recheck after async hashing: two installers cannot overwrite each other.
    if (config.setupComplete) throw fail("另一请求已完成初始化", 409);
    persistConfig({
      setupComplete: true,
      oauth: b.oauthToken || config.oauth,
      translateUrl: b.translatorUrl || config.translateUrl,
      translateKey: b.translatorKey || config.translateKey,
      translateModel: b.translatorModel,
      translatorProtocol: b.translatorProtocol || config.translatorProtocol,
      retentionDays: b.retentionDays,
      passwordHash,
      defaultRepo: b.repo,
    });
    const session =
      store.sessions().find((s) => s.repo === b.repo) || store.create(b.repo);
    logins.clear();
    const cookie = randomBytes(32).toString("hex");
    logins.set(cookie, Date.now() + LOGIN_SECONDS * 1000);
    reply.setCookie("folio_session", cookie, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: req.protocol === "https",
      maxAge: LOGIN_SECONDS,
    });
    return { ok: true, session };
  });
}
