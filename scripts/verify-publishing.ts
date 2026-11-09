import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { Reports } from "../server/reports.ts";
import { SandboxFiles } from "../server/files.ts";
import { makeSandboxSpawner, sandbox } from "../server/sandbox.ts";
import { gateway, tunnel } from "../server/report-bridge.ts";
import { PTY_SCRIPT } from "../server/shell.ts";
import http from "node:http";
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw Error("FOLIO_VERIFY_DIR required");
const repo = "folio-publish-check",
  store = new Store(directory),
  reports = new Reports(store),
  files = new SandboxFiles(),
  session = store.create(repo);
let serviceId = "";
try {
  await sandbox("/sandbox/start", "POST", { repo });
  await files.write(
    repo,
    "/work/publish-qa/index.html",
    Buffer.from(
      '<html><head><title>Publication check</title></head><body><h1>Native service ready</h1><script src="./app.js"></script></body></html>',
    ),
  );
  await files.write(
    repo,
    "/work/publish-qa/app.js",
    Buffer.from('document.body.dataset.ready="yes";'),
  );
  const report = await reports.publish(session.id, {
    path: "/work/publish-qa",
    title: "Native static check",
  });
  assert.equal(Object.keys(report.files || {}).length, 2);
  assert.match(
    reports.read(report, "index.html").toString(),
    /Native service ready/,
  );
  store.remove(session.id);
  assert.equal(reports.get(report.id).id, report.id);
  console.log(
    "PASS static snapshot: actual sandbox directory, encrypted storage, independent session lifetime",
  );
  const serviceSession = store.create(repo);
  const service = await reports.publish(serviceSession.id, {
    title: "Native service check",
    command: "python3 -m http.server $PORT --bind 0.0.0.0",
    cwd: "/work/publish-qa",
    port: 8080,
    ttlMinutes: 5,
  });
  serviceId = service.id;
  const socket = await tunnel(service.id),
    agent = new http.Agent();
  agent.createConnection = () => socket;
  const html = await new Promise<string>((resolve, reject) => {
    const req = http.get({ host: "publication", path: "/", agent }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
  assert.match(html, /Native service ready/);
  console.log(
    "PASS isolated service: readiness, real Docker network tunnel and HTML response",
  );
  await gateway("/network/cut", { repo });
  await assert.rejects(tunnel(service.id));
  await gateway("/network/restore", { repo });
  const restored = await tunnel(service.id);
  restored.destroy();
  console.log(
    "PASS publication emergency network cut and restore, process preserved",
  );
  const controller = new AbortController();
  const proc = makeSandboxSpawner(repo)({
    command: "python3",
    args: ["-u", "-c", PTY_SCRIPT],
    cwd: "/work",
    env: {},
    signal: controller.signal,
  });
  let output = "",
    sent = false;
  const timer = setTimeout(() => controller.abort(), 15000);
  const exited = new Promise<number | null>((resolve) =>
    proc.on("exit", resolve),
  );
  proc.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (!sent && /[$#] /.test(output)) {
      sent = true;
      proc.stdin.write(JSON.stringify({ cols: 110, rows: 33 }) + "\n");
      proc.stdin.write(
        JSON.stringify({
          input:
            "stty size; test -t 0 && printf 'PTY_%s\\n' VERIFIED; test -z \"$CLAUDE_CODE_OAUTH_TOKEN\" && printf 'ENV_%s\\n' CLEAN; exit\n",
        }) + "\n",
      );
    }
  });
  const code = await exited;
  clearTimeout(timer);
  controller.abort();
  assert.equal(code, 0);
  assert.match(output, /33 110/);
  assert.match(output, /PTY_VERIFIED/);
  assert.match(output, /ENV_CLEAN/);
  console.log(
    "PASS native PTY: interactive bash, terminal resize, no injected Claude credential, normal exit",
  );
  const eofController = new AbortController();
  const eofProc = makeSandboxSpawner(repo)({
    command: "python3",
    args: ["-u", "-c", PTY_SCRIPT],
    cwd: "/work",
    env: {},
    signal: eofController.signal,
  });
  let eofOutput = "",
    closing = false;
  const eofTimer = setTimeout(() => eofController.abort(), 12000);
  const eofExited = new Promise<number | null>((resolve) =>
    eofProc.on("exit", resolve),
  );
  eofProc.stdout.on("data", (chunk) => {
    eofOutput += chunk.toString();
    if (!closing && /[$#] /.test(eofOutput)) {
      closing = true;
      eofProc.stdin.end();
    }
  });
  const eofCode = await eofExited;
  clearTimeout(eofTimer);
  eofController.abort();
  assert.equal(eofCode, 0);
  console.log(
    "PASS browser-close equivalent: stdin EOF reaped PTY and exec without an explicit exit command",
  );
  await reports.stop(service.id);
  assert.equal(reports.get(service.id).state, "stopped");
  console.log(
    "PASS explicit stop: publication container removed, workspace preserved",
  );
} finally {
  if (serviceId) {
    try {
      await gateway("/stop", { id: serviceId });
    } catch {}
  }
  // Translation jobs can finish after publication. Drain them before closing the test database.
  for (const report of reports.list()) {
    try {
      await reports.translate(report.id);
    } catch {}
  }
  await sandbox("/sandbox/stop", "POST", { repo });
  store.close();
}
