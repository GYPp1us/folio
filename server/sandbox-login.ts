import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { config, persistConfig } from "./config.ts";
import { claudeEnv } from "./auth-config.ts";
import { authStatus, makeSandboxSpawner, sandbox } from "./sandbox.ts";
import type { SandboxLogin } from "../shared/types.ts";

type Process = ReturnType<ReturnType<typeof makeSandboxSpawner>>;
type Flow = {
  state: SandboxLogin;
  controller: AbortController;
  process?: Process;
  timer: ReturnType<typeof setTimeout>;
  output: string;
  cleanup?: Promise<void>;
};
const active = (s: SandboxLogin) =>
  ["starting", "awaiting", "verifying"].includes(s.status);
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export function authorizationUrl(output: string): string | undefined {
  // URLs printed by native auth login are the only outward-facing CLI output.
  // Do not pass through stderr, account details, codes or credentials.
  for (const value of output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .match(/https:\/\/[^\s\x1b<>"']+/g) || []) {
    try {
      const url = new URL(value);
      if (
        [
          "claude.com",
          "claude.ai",
          "console.anthropic.com",
          "platform.claude.com",
          "auth.anthropic.com",
        ].includes(url.hostname) &&
        /\/authorize$/.test(url.pathname) &&
        url.searchParams.has("state") &&
        url.searchParams.has("code_challenge")
      )
        return url.toString();
    } catch {}
  }
}
export class SandboxLogins {
  private flows = new Map<string, Flow>();
  constructor(private beforeStart: (repo: string) => Promise<void>) {}
  get(repo: string) {
    return this.flows.get(repo)?.state;
  }
  busy(repo: string) {
    const flow = this.get(repo);
    return (!!flow && active(flow)) || !!this.flows.get(repo)?.cleanup;
  }
  private view(flow: Flow): SandboxLogin {
    return { ...flow.state };
  }
  async start(repo: string): Promise<SandboxLogin> {
    const previous = this.flows.get(repo);
    if (previous && active(previous.state)) return this.view(previous);
    if (previous?.cleanup) await previous.cleanup;
    const current = this.flows.get(repo);
    if (current && current !== previous && active(current.state))
      return this.view(current);
    if (previous) clearTimeout(previous.timer);
    const state: SandboxLogin = {
      id: randomUUID(),
      repo,
      status: "starting",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    const flow: Flow = {
      state,
      controller: new AbortController(),
      output: "",
      timer: setTimeout(
        () => void this.cancel(repo, "授权链接已过期，请重新发起登录。"),
        600000,
      ),
    };
    this.flows.set(repo, flow);
    try {
      await this.beforeStart(repo);
      await sandbox("/sandbox/start", "POST", { repo });
      if (!active(state)) return this.view(flow);
      const proc = makeSandboxSpawner(repo)({
        command: "sh",
        args: ["-c", "exec claude auth login --claudeai"],
        cwd: "/work",
        env: { ...claudeEnv(repo, true), FOLIO_AUTH_FLOW_ID: state.id },
        signal: flow.controller.signal,
      });
      flow.process = proc;
      const read = (chunk: Buffer) => {
        if (!active(state)) return;
        flow.output = (flow.output + chunk.toString()).slice(-65536);
        const url = authorizationUrl(flow.output);
        if (url) {
          state.url = url;
          if (state.status === "starting") state.status = "awaiting";
        }
      };
      proc.stdout.on("data", read);
      (proc as Process & { stderr?: Readable }).stderr?.on("data", read);
      proc.stdin.on("error", () => {
        if (active(state))
          void this.cancel(repo, "登录进程连接已断开，请重试。");
      });
      proc.on(
        "exit",
        (code: number | null) => void this.finish(flow, code ?? 1),
      );
      proc.on(
        "error",
        () => void this.cancel(repo, "登录进程启动失败，请重试。"),
      );
      return this.view(flow);
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : "无法启动登录";
      clearTimeout(flow.timer);
      flow.controller.abort();
      flow.output = "";
      throw error;
    }
  }
  submit(repo: string, id: string, code: string) {
    const flow = this.flows.get(repo);
    if (
      !flow ||
      flow.state.id !== id ||
      !["awaiting", "verifying"].includes(flow.state.status)
    )
      throw fail("授权请求已结束，请重新发起登录。", 409);
    if (flow.state.status === "verifying")
      throw fail("正在验证授权，请稍候。", 409);
    const value = code.trim();
    if (value.length < 3 || value.length > 4096 || /[\r\n\x00]/.test(value))
      throw fail("请粘贴页面显示的单行授权码。");
    if (!flow.process || flow.process.stdin.destroyed)
      throw fail("登录连接已断开，请重试。", 409);
    flow.state.status = "verifying";
    // The one-time credential travels directly to native CLI stdin. It never
    // enters messages, translation, settings, logs, or command arguments.
    flow.process.stdin.write(value + "\n");
    return this.view(flow);
  }
  private async finish(flow: Flow, code: number) {
    if (!active(flow.state)) return;
    try {
      if (code !== 0)
        throw fail(
          /429|rate.?limit/i.test(flow.output)
            ? "Claude 授权服务正在限流，请稍后重新登录。"
            : "授权没有完成，请重新打开登录链接后重试。",
        );
      flow.state.status = "verifying";
      const auth = await authStatus(flow.state.repo, true);
      if (!auth.loggedIn || auth.authMethod !== "claude.ai")
        throw fail("未检测到完整网页登录凭证，请重新授权。");
      if (!active(flow.state)) return;
      persistConfig({
        webLoginRepos: [...new Set([...config.webLoginRepos, flow.state.repo])],
      });
      flow.state.status = "complete";
      flow.state.url = undefined;
    } catch (error) {
      if (active(flow.state)) {
        flow.state.status = "error";
        flow.state.error =
          error instanceof Error ? error.message : "登录验证失败";
        flow.state.url = undefined;
      }
    } finally {
      clearTimeout(flow.timer);
      flow.output = "";
      flow.process = undefined;
    }
  }
  async cancel(repo: string, message?: string) {
    const flow = this.flows.get(repo);
    if (flow?.cleanup) return flow.cleanup;
    if (!flow || !active(flow.state)) return;
    flow.state.status = message ? "error" : "cancelled";
    flow.state.error = message;
    flow.state.url = undefined;
    clearTimeout(flow.timer);
    flow.controller.abort();
    flow.output = "";
    flow.process = undefined;
    flow.cleanup = this.stopNativeLogin(flow)
      .catch(() => {
        flow.state.status = "error";
        flow.state.error =
          "登录已取消，但未能核实进程退出；请在没有任务运行时重建容器。";
      })
      .finally(() => {
        flow.cleanup = undefined;
      });
    await flow.cleanup;
  }
  private async stopNativeLogin(flow: Flow) {
    // HTTP disconnect only closes Docker stdio. Signal our unique auth-login
    // process explicitly; leave other Claude sessions and the container intact.
    const script = [
      "for attempt in 1 2; do",
      "for entry in /proc/[0-9]*/environ; do",
      '  [ -r "$entry" ] || continue',
      `  if tr '\\000' '\\n' < "$entry" 2>/dev/null | grep -Fqx 'FOLIO_AUTH_FLOW_ID=${flow.state.id}'; then`,
      "    pid=${entry#/proc/}; pid=${pid%/environ}",
      `    if tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'claude[[:space:]]+auth[[:space:]]+login'; then kill -TERM "$pid" 2>/dev/null || true; fi`,
      "  fi",
      "done",
      '[ "$attempt" = 2 ] || sleep 0.3',
      "done",
    ].join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const p = makeSandboxSpawner(flow.state.repo)({
        command: "sh",
        args: ["-c", script],
        cwd: "/work",
        env: claudeEnv(flow.state.repo, true),
        signal: controller.signal,
      });
      p.stdout.resume();
      (p as Process & { stderr?: Readable }).stderr?.resume();
      const code = await new Promise<number | null>((resolve) => {
        p.on("exit", resolve);
        p.stdin.end();
      });
      if (code !== 0) throw new Error("Could not stop login process");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async tokenMode(repo: string) {
    await this.cancel(repo);
    await this.beforeStart(repo);
    persistConfig({
      webLoginRepos: config.webLoginRepos.filter((r) => r !== repo),
    });
    return { ok: true };
  }
  async forget(repo: string) {
    await this.cancel(repo);
    this.flows.delete(repo);
    persistConfig({
      webLoginRepos: config.webLoginRepos.filter((r) => r !== repo),
    });
  }
  housekeep() {
    for (const [repo, flow] of this.flows)
      if (
        !active(flow.state) &&
        Date.now() - Date.parse(flow.state.expiresAt) > 1800000
      )
        this.flows.delete(repo);
  }
  async shutdown() {
    await Promise.all([...this.flows.keys()].map((repo) => this.cancel(repo)));
  }
}
