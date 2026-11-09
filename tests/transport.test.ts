import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeSandboxSpawner } from "../server/sandbox.ts";
function frame(stream: number, value: Buffer) {
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(value.length, 4);
  return Buffer.concat([head, value]);
}
test("SDK 参数与 stdin 原样传递，碎片帧正确拆出 stdout/stderr/退出码", async () => {
  let headers: Record<string, unknown> = {},
    body = "";
  const server = createServer((req, res) => {
    headers = req.headers;
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200);
      const exit = Buffer.alloc(4);
      exit.writeInt32BE(7);
      const bytes = Buffer.concat([
        frame(1, Buffer.from("hello 世界")),
        frame(2, Buffer.from("diagnostic")),
        frame(3, exit),
      ]);
      res.write(bytes.subarray(0, 5));
      res.write(bytes.subarray(5, 17));
      res.end(bytes.subarray(17));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const args = [
      "--input-format",
      "stream-json",
      "--resume",
      "session with spaces",
      "$(literal)",
      "中文参数",
    ];
    const p = makeSandboxSpawner(
      "test-repo",
      `http://127.0.0.1:${address.port}`,
      "test-token",
    )({
      command: "/sdk/cli",
      args,
      cwd: "/work",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "test-oauth", YJ_PERSON: "林晓" },
      signal: new AbortController().signal,
    });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    (p as typeof p & { stderr: import("node:stream").Readable }).stderr.on(
      "data",
      (c) => (stderr += c),
    );
    const exited = new Promise<number | null>((resolve) =>
      p.on("exit", (code) => resolve(code)),
    );
    p.stdin.end('{"type":"user","content":"hello"}\n');
    assert.equal(await exited, 7);
    assert.equal(stdout, "hello 世界");
    assert.equal(stderr, "diagnostic");
    assert.deepEqual(JSON.parse(headers["x-ccsb-args"] as string), args);
    assert.equal(body, '{"type":"user","content":"hello"}\n');
    assert.equal(headers["x-ccsb-repo"], "test-repo");
    assert.equal(JSON.parse(headers["x-ccsb-env"] as string).YJ_PERSON, "林晓");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("缺少退出帧的连接不会被误报成功", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(frame(1, Buffer.from("partial")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const p = makeSandboxSpawner(
      "test",
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      "token",
    )({
      command: "claude",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const exited = new Promise<number | null>((resolve) =>
      p.on("exit", (code) => resolve(code)),
    );
    p.stdin.end();
    assert.equal(await exited, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("退出帧之后的尾帧和关闭事件不会写入已结束的流", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end(
      Buffer.concat([
        frame(3, Buffer.alloc(4)),
        frame(2, Buffer.from("late diagnostic")),
      ]),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const controller = new AbortController();
    const p = makeSandboxSpawner(
      "test",
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      "token",
    )({ command: "claude", args: [], env: {}, signal: controller.signal });
    let diagnostics = "";
    (p as typeof p & { stderr: import("node:stream").Readable }).stderr.on(
      "data",
      (c) => (diagnostics += c),
    );
    const result = new Promise<number | null>((r) => p.on("exit", r));
    p.stdin.end();
    assert.equal(await result, 0);
    controller.abort();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(diagnostics, "");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
