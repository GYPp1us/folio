import assert from "node:assert/strict";
import { SandboxLogins } from "../server/sandbox-login.ts";
import { claudeEnv } from "../server/auth-config.ts";
import { sandbox, makeSandboxSpawner } from "../server/sandbox.ts";
import { config } from "../server/config.ts";
const repo = "folio-login-check",
  before = JSON.stringify(config.webLoginRepos);
const manager = new SandboxLogins(async () => {});
try {
  const first = await manager.start(repo);
  for (let n = 0; n < 100 && !manager.get(repo)?.url; n++) {
    if (manager.get(repo)?.status === "error")
      throw new Error(manager.get(repo)?.error);
    await new Promise((r) => setTimeout(r, 150));
  }
  const state = manager.get(repo);
  assert.ok(state?.url, "No native authorization URL");
  const url = new URL(state.url);
  assert.ok(url.searchParams.get("scope")?.split(" ").includes("user:profile"));
  assert.ok(url.searchParams.has("code_challenge"));
  console.log(
    "PASS: native sandbox OAuth authorization requests profile scope with PKCE.",
  );
  await manager.cancel(repo);
  assert.equal(manager.get(repo)?.status, "cancelled");
  assert.equal(manager.busy(repo), false);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 7000);
  try {
    const script = `for entry in /proc/[0-9]*/environ; do [ -r "$entry" ] || continue; if tr '\\000' '\\n' < "$entry" 2>/dev/null | grep -Fqx 'FOLIO_AUTH_FLOW_ID=${first.id}'; then pid=\${entry#/proc/}; pid=\${pid%/environ}; if tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'claude[[:space:]]+auth[[:space:]]+login'; then printf '%s\\n' "$pid"; fi; fi; done`;
    const proc = makeSandboxSpawner(repo)({
      command: "sh",
      args: ["-c", script],
      cwd: "/work",
      env: claudeEnv(repo, true),
      signal: controller.signal,
    });
    let output = "";
    proc.stdout.on("data", (c) => (output += c.toString()));
    const code = await new Promise((r) => {
      proc.on("exit", r);
      proc.stdin.end();
    });
    assert.equal(code, 0);
    assert.equal(output.trim(), "", "Cancelled auth process is still running");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  assert.equal(JSON.stringify(config.webLoginRepos), before);
  console.log(
    "PASS: cancellation terminates only the native login process; saved login selection unchanged.",
  );
} finally {
  await manager.shutdown();
  await sandbox("/sandbox/stop", "POST", { repo });
  assert.equal((await sandbox("/sandbox/status?repo=" + repo)).running, false);
  console.log("PASS: verification sandbox stopped; volumes retained.");
}
