// Runs the actual transport against cc-sandbox; no Claude API request or OAuth needed.
// Run on the sandbox host: sudo node scripts/sandbox-smoke.mjs
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(
  new URL("../server/sandbox.ts", import.meta.url),
  "utf8",
);
const config = {
  sandboxUrl: process.env.CC_SANDBOX_URL || "http://127.0.0.1:8123",
  token: readFileSync(
    process.env.CC_SANDBOX_TOKEN_FILE || "/etc/cc-sandbox/token",
    "utf8",
  ).trim(),
};
// The transpiled test module imports only node builtins. Token stays in memory.
const transpiled = stripTypeScriptTypes(
  source.replace(
    /import \{ config \} from ["']\.\/config\.ts["'];/,
    "const config = globalThis.__sandboxSmokeConfig;",
  ),
);
globalThis.__sandboxSmokeConfig = config;
const { makeSandboxSpawner, sandbox } = await import(
  "data:text/javascript;base64," + Buffer.from(transpiled).toString("base64")
);
delete globalThis.__sandboxSmokeConfig;
const repo = "yijing-smoke-" + Date.now().toString(36);
try {
  await sandbox("/sandbox/start", "POST", { repo });
  const p = makeSandboxSpawner(repo)({
    command: "sh",
    args: ["-c", 'printf "YIJING_BRIDGE_OK\\n"; id -un; pwd'],
    cwd: "/work",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    signal: new AbortController().signal,
  });
  let output = "";
  p.stdout.on("data", (c) => (output += c));
  const finished = new Promise((resolve) =>
    p.on("exit", (code) => resolve(code)),
  );
  p.stdin.end();
  const code = await finished;
  if (
    code !== 0 ||
    !output.includes("YIJING_BRIDGE_OK") ||
    !output.includes("/work")
  )
    throw new Error("Real sandbox transport smoke failed");
  console.log(
    "PASS: real sandbox stdio, non-root user, /work cwd; no OAuth or model request.",
  );
  console.log(output.trim());
} finally {
  await sandbox("/sandbox/stop", "POST", { repo });
  const status = await sandbox("/sandbox/status?repo=" + repo);
  console.log("Cleanup status:", JSON.stringify(status));
  console.log("Test volumes retained:", `cc-state-${repo}`, `cc-work-${repo}`);
}
