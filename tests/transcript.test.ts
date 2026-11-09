import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildTranscript,
  finalReplyStart,
  markdownSegments,
  StreamSegments,
} from "../shared/transcript.ts";
import type { Message, TraceBlock } from "../shared/types.ts";
import { richParts } from "../shared/rich.ts";
import { Store } from "../server/store.ts";
import { fakeServices } from "./fake-services.ts";
import { startServer, testDirectory } from "./server-helper.ts";
let tick = 0;
const date = () => new Date(1700000000000 + tick++).toISOString();
const message = (
  role: Message["role"],
  runId: string,
  text: string,
): Message => ({
  id: randomUUID(),
  role,
  runId,
  original: text,
  chinese: "",
  createdAt: date(),
});
const block = (
  kind: TraceBlock["kind"],
  runId: string,
  toolId?: string,
): TraceBlock => ({
  id: randomUUID(),
  sessionId: "s",
  runId,
  kind,
  title: kind,
  original: "result " + runId,
  createdAt: date(),
  translationState: "none",
  toolId,
});

test("时间线保留插话顺序、工具结果按轮关联，完成聚焦最后一段最终回复", () => {
  const messages: Message[] = [],
    blocks: TraceBlock[] = [];
  messages.push(message("user", "r1", "first"));
  blocks.push(block("commentary", "r1"), block("tool", "r1", "same"));
  messages.push({ ...message("user", "r1", "steer"), kind: "steering" });
  blocks.push(block("tool_result", "r1", "same"));
  messages.push(message("assistant", "r1", "first reply"));
  messages.push(message("user", "r2", "second"));
  blocks.push(block("tool", "r2", "same"), block("tool_result", "r2", "same"));
  messages.push(message("assistant", "r2", "reply two"));
  messages.push(message("assistant", "r2", "queued final reply"));
  const rows = buildTranscript(messages, blocks, [], "zh");
  assert.deepEqual(
    rows.slice(0, 5).map((r) => r.kind),
    ["message", "dialogue", "tool", "message", "message"],
  );
  const tools = rows.filter((r) => r.kind === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].results[0].runId, "r1");
  assert.equal(tools[1].results[0].runId, "r2");
  assert.equal(
    rows[finalReplyStart(rows, "r2")].message?.original,
    "queued final reply",
  );
  assert.equal(finalReplyStart(rows, "absent"), -1);
});
test("整轮执行过程默认折叠，展开保留时序，运行中或无最终回复时也可正确显示", () => {
  const first = message("user", "finished", "start");
  const commentary = block("commentary", "finished");
  const call = block("tool", "finished", "bash");
  const steer = message("user", "finished", "steer");
  const result = block("tool_result", "finished", "bash");
  const final = message("assistant", "finished", "final");
  const orphan = block("tool_progress", "failed");
  const active = block("commentary", "active");
  const messages = [first, steer, final];
  const blocks = [commentary, call, result, orphan, active];
  const options = { activeRunId: "active", expanded: new Set<string>() };
  const collapsed = buildTranscript(messages, blocks, [], "zh", options);
  assert.deepEqual(
    collapsed.map((row) => row.kind),
    ["message", "message", "run-summary", "message", "run-summary", "dialogue"],
  );
  assert.equal(collapsed[2].detailCount, 2);
  assert.equal(collapsed[3].message?.id, final.id);
  assert.equal(collapsed[4].detailCount, 1);
  assert.equal(collapsed.at(-1)?.block?.id, active.id);
  options.expanded.add("finished");
  const expanded = buildTranscript(messages, blocks, [], "zh", options);
  assert.deepEqual(
    expanded.slice(0, 6).map((row) => row.kind),
    ["message", "run-summary", "dialogue", "tool", "message", "message"],
  );
  assert.equal(expanded[1].key, collapsed[2].key);
  assert.equal(expanded[3].results[0].id, result.id);
  assert.equal(expanded[5].key, collapsed[3].key);
});

test("长 Markdown 在块边界分段，代码/HTML保持完整且参考链接在各段可解析", () => {
  const html = "```html\n<section><p>Preview</p></section>\n```";
  const code = "```ts\n" + "const a=1;\n".repeat(1200) + "```";
  const source =
    Array.from(
      { length: 80 },
      (_, i) => `## Part ${i}\n\n${"A normal paragraph. ".repeat(30)}`,
    ).join("\n\n") +
    "\n\n" +
    code +
    "\n\n" +
    html;
  const parts = markdownSegments(source, 2000);
  assert.ok(parts.length > 10);
  assert.equal(parts.join(""), source);
  assert.equal(parts.filter((p) => p.includes("const a=1")).length, 1);
  assert.equal(parts.filter((p) => richParts(p).length).length, 1);
  const linked = markdownSegments(
    ("Long paragraph. ".repeat(100) + "\n\n").repeat(10) +
      "[Read][ref]\n\n[ref]: https://example.com",
    1000,
  );
  assert.ok(linked.every((p) => p.includes("[ref]: https://example.com")));
});
test("单轮数千工具可独立窗口化；翻译更新不改变最终回复首片的 key", () => {
  const messages = [message("user", "r", "check")],
    blocks: TraceBlock[] = [];
  for (let i = 0; i < 2500; i++)
    blocks.push(
      block("tool", "r", "t" + i),
      block("tool_result", "r", "t" + i),
    );
  const reply = message(
    "assistant",
    "r",
    ("Paragraph. ".repeat(100) + "\n\n").repeat(35),
  );
  messages.push(reply);
  const rows = buildTranscript(messages, blocks, [], "zh");
  assert.equal(rows.filter((r) => r.kind === "tool").length, 2500);
  assert.ok(rows.length > 2503);
  const oldKey = rows[finalReplyStart(rows, "r")].key;
  const translated = buildTranscript(
    [
      messages[0],
      { ...reply, chinese: ("中文回复。".repeat(80) + "\n\n").repeat(20) },
    ],
    blocks,
    [],
    "both",
  );
  assert.equal(translated[finalReplyStart(translated, "r")].key, oldKey);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test(
  "长会话尾部读取有界；增量 SSE、兼容模式和重连快照不会丢失或重复回复",
  { timeout: 20000 },
  async () => {
    const fake = await fakeServices({
      latencyMs: 300,
      streamChunks: ["Com", "ple", "ted."],
      streamPauseMs: 400,
    });
    const dir = testDirectory(),
      store = new Store(dir),
      session = store.create("incremental-test");
    for (let i = 0; i < 40; i++)
      store.add(session.id, {
        role: i % 2 ? "assistant" : "user",
        original: "history " + i,
        chinese: "",
      });
    store.close();
    const server = await startServer(dir, "", {
      APP_SKIP_SETUP: "1",
      CC_SANDBOX_URL: fake.base,
      CLAUDE_CODE_OAUTH_TOKEN: "test",
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "deepseek-test",
    });
    const request = async (path: string, body?: unknown) =>
      (
        await fetch(server.base + path, {
          method: body === undefined ? "GET" : "POST",
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      ).json();
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const controller = new AbortController();
    try {
      const tail = await request(`/sessions/${session.id}?tail=1`);
      assert.equal(tail.messages.length, 8);
      assert.equal(tail.blocks, undefined);
      assert.equal(tail.messages[0].original, "history 32");
      const full = await request(`/sessions/${session.id}`);
      assert.equal(full.messages.length, 40);
      let firstDelta!: () => void;
      const first = new Promise<void>((resolve) => (firstDelta = resolve));
      const collect = async (path: string) => {
        const stream = await fetch(server.base + path, {
          signal: controller.signal,
        });
        const reader = stream.body!.getReader();
        readers.push(reader);
        let wire = "";
        const pump = (async () => {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            wire += new TextDecoder().decode(chunk.value);
            if (wire.includes('"delta":"Com"')) firstDelta();
          }
        })();
        return {
          pump,
          values: () =>
            wire
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6))),
        };
      };
      const delta = await collect(
          `/sessions/${session.id}/events?stream=delta`,
        ),
        legacy = await collect(`/sessions/${session.id}/events`);
      const run = await request("/messages", {
        sessionId: session.id,
        prompt: "Reply OK",
        mode: "direct",
        downstreamMode: "manual",
      });
      await first;
      const reconnect = await fetch(
        server.base + `/sessions/${session.id}/events?stream=delta`,
        { signal: controller.signal },
      );
      const r = reconnect.body!.getReader();
      const snapshotWire = new TextDecoder().decode((await r.read()).value);
      await r.cancel();
      const snapshot = JSON.parse(
        snapshotWire
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      );
      assert.match(snapshot.live.text, /^Com/);
      await (await fetch(server.base + `/runs/${run.runId}/events`)).text();
      const { session: updated } = await request(
        `/sessions/${session.id}?tail=1`,
      );
      assert.equal(updated.usage.last_result.durationMs, 800);
      assert.equal(updated.usage.last_result.apiMs, 10);
      assert.ok(
        updated.usage.last_result.tps > 0 && updated.usage.last_result.tps < 15,
      );
      for (const reader of readers) await reader.cancel();
      await Promise.all([delta.pump, legacy.pump]);
      const pieces = delta
        .values()
        .filter((v) => v.live?.delta !== undefined)
        .map((v) => v.live.delta);
      assert.deepEqual(pieces, ["Com", "ple", "ted."]);
      assert.equal(pieces.join(""), "Completed.");
      assert.deepEqual(
        legacy
          .values()
          .filter((v) => v.live?.text)
          .map((v) => v.live.text),
        ["Com", "Comple", "Completed."],
      );
      assert.equal(
        (await request(`/sessions/${session.id}?tail=1`)).messages.at(-1)
          .original,
        "Completed.",
      );
    } finally {
      controller.abort();
      await server.stop();
      await fake.close();
    }
  },
);

test("实时长回复封存完整片段，增量、消息重置和会话切换均不丢失或重用旧文", () => {
  const stream = new StreamSegments();
  const source = Array.from(
    { length: 120 },
    (_, i) => `## Part ${i}\n\n${"Streaming text. ".repeat(50)}`,
  ).join("\n\n");
  let first = "";
  for (let length = 1000; length < source.length; length += 1000) {
    const text = source.slice(0, length),
      parts = stream.update(text, "one");
    assert.equal(parts.join(""), text);
    if (parts.length > 1) {
      if (first) assert.equal(parts[0], first);
      else first = parts[0];
    }
  }
  assert.equal(stream.update(source, "one").join(""), source);
  assert.deepEqual(stream.update("", "one"), []);
  assert.deepEqual(stream.update("New assistant message", "one"), [
    "New assistant message",
  ]);
  assert.deepEqual(stream.update("Different run", "two"), ["Different run"]);
});
