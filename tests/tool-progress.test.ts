import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../server/store.ts";
import { RuntimeManager, type Run } from "../server/runtime.ts";
import { autoTranslate } from "../server/translations.ts";
import { normalizeProgress } from "../shared/tool-progress.ts";
import { buildTranscript } from "../shared/transcript.ts";
import { ToolDetail, ProcessGroup } from "../src/Process.tsx";
import { testDirectory, startServer } from "./server-helper.ts";
import type { TraceBlock } from "../shared/types.ts";
const command =
  "mkdir -p /tmp/reports && cat > /tmp/reports/review.py <<'PY'\nprint('<script>example</script>')\nPY";
function block(
  kind: TraceBlock["kind"],
  original: string,
  extra: Partial<TraceBlock> = {},
): TraceBlock {
  return {
    id: randomUUID(),
    sessionId: "s",
    runId: "r",
    createdAt: new Date().toISOString(),
    kind,
    title: kind,
    original,
    translationState: "none",
    ...extra,
  };
}
test("SDK 系统进度和工具摘要归到工具，原始助手正文仍是对话，进度不结束待执行工具", async () => {
  const store = new Store(testDirectory()),
    manager = new RuntimeManager(store),
    session = store.create("progress-check");
  store.save({ ...session, downstreamMode: "manual" });
  const run: Run = {
    id: randomUUID(),
    sessionId: session.id,
    repo: session.repo,
    events: [],
    listeners: new Set(),
    done: false,
    output: "",
    streamed: false,
    generation: 1,
    startedAt: Date.now(),
    interrupted: false,
    pendingTools: new Map(),
    blockKinds: new Map(),
  };
  const connection = { session, run, controller: new AbortController() } as any;
  const receive = (msg: any) => (manager as any).receive(connection, msg);
  try {
    await receive({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command } },
        ],
      },
    });
    await receive({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "bash-1",
      description: "Preparing report",
    });
    await receive({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      summary: "Waiting for remote API",
    });
    await receive({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      summary: command,
      status: "failed",
    });
    await receive({
      type: "tool_use_summary",
      preceding_tool_use_ids: ["bash-1"],
      summary: "Report prepared",
    });
    await receive({
      type: "system",
      subtype: "future_notice",
      text: "Background detail",
    });
    await receive({
      type: "assistant",
      message: { content: [{ type: "text", text: command }] },
    });
    const blocks = store.blocks(session.id),
      progress = blocks.filter((b) => b.kind === "tool_progress");
    assert.equal(progress.length, 5);
    assert.equal(blocks.filter((b) => b.kind === "commentary").length, 1);
    assert.equal(
      blocks.find((b) => b.kind === "commentary")!.original,
      command,
    );
    assert.ok(progress.slice(0, 4).every((b) => b.toolId === "bash-1"));
    const rawCommand = progress.find((b) => b.original === command)!;
    assert.equal((rawCommand.data as any).format, "code");
    assert.equal(rawCommand.original, command);
    assert.ok(run.pendingTools?.has("bash-1"));
    const rows = buildTranscript([], blocks, [], "zh"),
      call = rows.find((r) => r.block?.kind === "tool")!;
    assert.equal(call.results.length, 4);
    assert.equal(rows.filter((r) => r.kind === "dialogue").length, 1);
    assert.equal(autoTranslate("tool_progress", "messages"), false);
    const translated = await manager.translations.translate(rawCommand.id);
    assert.equal(translated.chinese, command);
    assert.equal(translated.translationState, "done");
  } finally {
    await manager.translations.shutdown();
    await manager.media.shutdown();
    store.close();
  }
});
test("历史执行进度按同一轮最近的相同命令关联；不猜测普通助手正文，不篡改历史内容", () => {
  const call = block("tool", "params", {
    toolId: "one",
    data: { name: "Bash", input: { command } },
  });
  const previous = block("commentary", command, {
    title: "执行进度",
    chinese: "Old translated command",
  });
  const repeated = block("tool", "params", {
    toolId: "two",
    data: { name: "Bash", input: { command } },
  });
  const second = block("commentary", command, { title: "执行进度" });
  const dialogue = block("commentary", command, { title: "Claude Code 输出" });
  const otherRun = block("commentary", command, {
    title: "执行进度",
    runId: "different",
  });
  const unrelated = block("commentary", "Waiting for external API", {
    title: "执行进度",
  });
  const before = JSON.stringify([previous, second, dialogue]);
  const normalized = normalizeProgress([
    call,
    previous,
    repeated,
    second,
    dialogue,
    otherRun,
    unrelated,
  ]);
  assert.equal(normalized[1].toolId, "one");
  assert.equal(normalized[3].toolId, "two");
  assert.equal(normalized[1].kind, "tool_progress");
  assert.equal((normalized[1].data as any).format, "code");
  assert.equal(normalized[4], dialogue);
  assert.equal(normalized[5].toolId, undefined);
  assert.equal(normalized[6].kind, "tool_progress");
  assert.equal(JSON.stringify([previous, second, dialogue]), before);
  assert.equal(normalized[1].chinese, previous.chinese);
});
test("进度默认折叠；运行中不会被标为已返回；命令展开后使用转义的等宽代码并保留换行", () => {
  const call = block("tool", "Tool parameters", {
    title: "Bash",
    toolId: "one",
  });
  const progress = block("tool_progress", command, {
    title: "执行进度",
    toolId: "one",
    data: { format: "code", language: "bash" },
  });
  const collapsed = renderToStaticMarkup(
    createElement(ToolDetail, {
      block: call,
      results: [progress],
      view: "zh",
      onError: () => {},
    }),
  );
  assert.ok(collapsed.includes("运行中"));
  assert.ok(!collapsed.includes("已返回"));
  assert.ok(!collapsed.includes("mkdir"));
  assert.ok(!collapsed.includes("<details open"));
  const expanded = renderToStaticMarkup(
    createElement(ToolDetail, {
      block: call,
      results: [progress],
      view: "zh",
      open: true,
      onError: () => {},
    }),
  );
  assert.match(expanded, /<pre class="tool-command"><code>/);
  assert.ok(expanded.includes("&lt;script&gt;example&lt;/script&gt;"));
  assert.ok(!expanded.includes("<script>example"));
  const failure = block(
    "tool_result",
    "Traceback (most recent call last):\n  File report.py, line 1\nRemoteDisconnected",
    { toolId: "one", data: { isError: true } },
  );
  const errorHtml = renderToStaticMarkup(
    createElement(ToolDetail, {
      block: call,
      results: [failure],
      view: "zh",
      open: true,
      onError: () => {},
    }),
  );
  assert.match(errorHtml, /<pre class="tool-command"><code>Traceback/);
  assert.ok(errorHtml.includes("\n  File report.py, line 1\n"));
  const grouped = renderToStaticMarkup(
    createElement(ProcessGroup, {
      blocks: [
        call,
        progress,
        block("commentary", "Actual assistant response"),
      ],
      view: "zh",
      onError: () => {},
    }),
  );
  assert.equal((grouped.match(/process-dialogue-head/g) || []).length, 1);
  assert.ok(!grouped.includes("mkdir"));
  assert.ok(grouped.includes("Actual assistant response"));
});
test("旧会话 API 自动返回修正后的进度类型，磁盘原始记录与 ID、译文保持不变", async () => {
  const directory = testDirectory(),
    store = new Store(directory),
    session = store.create("history-progress");
  const call = block("tool", "params", {
    sessionId: session.id,
    toolId: "old-bash",
    data: { name: "Bash", input: { command } },
  });
  const legacy = block("commentary", command, {
    sessionId: session.id,
    title: "执行进度",
    chinese: "Old translation",
    translationState: "done",
  });
  store.saveBlock(call);
  store.saveBlock(legacy);
  const encrypted = (
    store.db.prepare("SELECT data FROM blocks WHERE id=?").get(legacy.id) as any
  ).data;
  assert.equal(store.block(legacy.id)?.kind, "tool_progress");
  assert.equal(
    (
      store.db
        .prepare("SELECT data FROM blocks WHERE id=?")
        .get(legacy.id) as any
    ).data,
    encrypted,
  );
  store.close();
  const server = await startServer(directory, "", { APP_SKIP_SETUP: "1" });
  try {
    const response = await fetch(server.base + `/sessions/${session.id}`);
    assert.equal(response.status, 200);
    const detail = await response.json(),
      progress = detail.blocks.find((b: TraceBlock) => b.id === legacy.id);
    assert.equal(progress.kind, "tool_progress");
    assert.equal(progress.toolId, "old-bash");
    assert.equal(progress.original, command);
    assert.equal(progress.chinese, legacy.chinese);
  } finally {
    await server.stop();
  }
});
