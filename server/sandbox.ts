// Adapted from the user-supplied /opt/cc-sandbox/examples/spawn-via-sandbox.mjs.
// Protocol is owned by cc-sandbox; SDK argument arrays must remain unchanged.
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.ts";
import { claudeEnv } from "./auth-config.ts";

// HTTP headers are byte strings. Escape Unicode in JSON, without changing the
// argument/environment values the sandbox obtains after JSON.parse().
const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export function makeSandboxSpawner(
  repo: string,
  baseUrl = config.sandboxUrl,
  token = config.token,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => {
    const url = new URL("/sandbox/exec", baseUrl);
    const stdout = new PassThrough(),
      stderr = new PassThrough(),
      stdin = new PassThrough();
    const proc = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      pid: undefined as number | undefined,
    });
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      // Each exec owns a long-lived duplex socket. The Python bridge closes it
      // at EOF; reusing Node's idle HTTP socket races that close (ECONNRESET).
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        "x-ccsb-repo": repo,
        "x-ccsb-command": options.command,
        "x-ccsb-args": headerJson(options.args),
        "x-ccsb-cwd": options.cwd || "/work",
        "x-ccsb-env": headerJson(options.env || {}),
      },
    });
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      proc.exitCode = code;
      options.signal?.removeEventListener("abort", abort);
      stdin.unpipe(request);
      stdin.destroy();
      stdout.end();
      stderr.end();
      proc.emit("exit", code, proc.signalCode);
      proc.emit("close", code, proc.signalCode);
    };
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
      proc.killed = true;
      proc.signalCode = signal;
      request.destroy();
      finish(143);
      return true;
    };
    const abort = () => kill();
    Object.assign(proc, { kill });
    let buffer: Buffer = Buffer.alloc(0),
      sawExit = false;
    request.on("response", (response) => {
      if (finished) {
        response.resume();
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        stderr.write(`sandbox exec: HTTP ${response.statusCode}`);
        finish(1);
        return;
      }
      response.on("data", (chunk: Buffer) => {
        if (finished) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (!finished && buffer.length >= 8) {
          const stream = buffer[0],
            length = buffer.readUInt32BE(4);
          if (length > 16 * 1024 * 1024 || ![1, 2, 3].includes(stream)) {
            stderr.write("Invalid sandbox frame");
            request.destroy();
            finish(1);
            return;
          }
          if (buffer.length < length + 8) break;
          const payload = buffer.subarray(8, 8 + length);
          buffer = buffer.subarray(8 + length);
          if (stream === 1) stdout.write(payload);
          else if (stream === 2) stderr.write(payload);
          else {
            if (length !== 4) {
              finish(1);
              return;
            }
            sawExit = true;
            finish(payload.readInt32BE(0));
          }
        }
      });
      response.on("end", () => {
        if (!finished && !sawExit) {
          stderr.write("Sandbox stream ended without exit frame");
          finish(1);
        }
      });
      response.on("error", () => {
        if (finished) return;
        stderr.write("Sandbox stream interrupted");
        finish(1);
      });
    });
    request.on("error", () => {
      if (finished) return;
      stderr.write("Sandbox connection failed");
      finish(1);
    });
    stdin.pipe(request);
    request.flushHeaders();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(abort);
    return Object.assign(proc, { kill });
  };
}

export async function sandbox(path: string, method = "GET", body?: unknown) {
  if (!config.token)
    throw new Error(
      "未配置沙箱 Bearer token。请在服务器设置 CC_SANDBOX_TOKEN_FILE。",
    );
  const response = await fetch(new URL(path, config.sandboxUrl), {
    method,
    signal: AbortSignal.timeout(
      path.includes("backup") || path.includes("rebuild") ? 300000 : 30000,
    ),
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`沙箱服务返回 HTTP ${response.status}`);
  return response.json();
}

export async function authStatus(repo: string, forceWeb = false) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 12000);
  try {
    const p = makeSandboxSpawner(repo)({
      command: "claude",
      args: ["auth", "status"],
      cwd: "/work",
      env: claudeEnv(repo, forceWeb),
      signal: controller.signal,
    });
    let output = "";
    p.stdout.on("data", (chunk) => {
      if (output.length < 65536) output += chunk.toString();
    });
    p.stdin.end();
    await new Promise<void>((resolve) => p.on("exit", () => resolve()));
    try {
      const result = JSON.parse(output);
      return {
        loggedIn: !!result.loggedIn,
        authMethod: result.authMethod || "unknown",
      };
    } catch {
      return { loggedIn: false, authMethod: "unknown" };
    }
  } finally {
    clearTimeout(timer);
  }
}
