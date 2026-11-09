import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { Activities } from "../server/activity.ts";
import { activitySummary, type Activity } from "../shared/activity.ts";
import { Store } from "../server/store.ts";
import { RuntimeManager, type Run } from "../server/runtime.ts";
import { ProcessGroup } from "../src/Process.tsx";
import { api } from "../src/ui.tsx";
import { PAGE_CONTRACT } from "../server/media.ts";
import { startServer, testDirectory } from "./server-helper.ts";
import { fakeServices } from "./fake-services.ts";
import type { TraceBlock } from "../shared/types.ts";

test("状态重连保留阶段起点；输入、执行、输出并行且完成后不残留", () => {
  const updates: Activity[][] = [];
  const states = new Activities((_id, list) => updates.push(list));
  states.set("s", "run", "waiting_model", { scope: "run" });
  const first = states.list("s")[0];
  assert.equal(
    states.set("s", "run", "waiting_model", { scope: "run" }),
    false,
  );
  assert.equal(states.list("s")[0].since, first.since);
  states.set("s", "output", "translating", { scope: "downstream" });
  assert.equal(
    activitySummary(states.list("s")).primary?.phase,
    "waiting_model",
  );
  assert.match(activitySummary(states.list("s")).secondary, /输出处理中/);
  states.set("s", "input", "translating", { scope: "upstream" });
  assert.equal(activitySummary(states.list("s")).primary?.id, "input");
  assert.match(activitySummary(states.list("s")).secondary, /等待模型响应/);
  states.clear("s", "input");
  states.clear("s", "run");
  assert.equal(activitySummary(states.list("s")).primary?.id, "output");
  states.remove("s");
  assert.deepEqual(updates.at(-1), []);
});

test("SDK 的实际思考、工具、重试、压缩和授权事件驱动状态，结束后清理", async () => {
  const store = new Store(testDirectory()),
    manager = new RuntimeManager(store);
  const session = store.create("activity-test");
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
  manager.runs.set(run.id, run);
  const receive = (msg: any) => (manager as any).receive(connection, msg);
  const phase = () =>
    store.activities.list(session.id).find((a) => a.scope === "run")?.phase;
  const stream = (event: any) =>
    receive({ type: "stream_event", parent_tool_use_id: null, event });
  try {
    await receive({ type: "system", subtype: "status", status: "requesting" });
    assert.equal(phase(), "waiting_model");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(phase(), "waiting_model", "不能把沉默误标为思考");
    await receive({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 120,
    });
    assert.equal(phase(), "thinking");
    await stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    await stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "plan" },
    });
    assert.equal(phase(), "thinking");
    await stream({ type: "content_block_stop", index: 0 });
    assert.equal(phase(), "waiting_model");
    await receive({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "I will inspect the file." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/work/a" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    });
    assert.equal(phase(), "waiting_tool");
    await receive({
      type: "tool_progress",
      tool_use_id: "t1",
      tool_name: "Read",
    });
    const question = manager.ask(connection, "permission", "Allow?", {});
    assert.equal(phase(), "waiting_user");
    await receive({
      type: "tool_progress",
      tool_use_id: "t1",
      tool_name: "Read",
    });
    assert.equal(phase(), "waiting_user", "并行工具心跳不能覆盖待确认状态");
    const id = [...manager.questions.keys()][0];
    await manager.answer(id, { allow: true });
    assert.equal((await question).allow, true);
    assert.equal(phase(), "waiting_tool");
    await receive({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    });
    assert.equal(phase(), "waiting_tool", "另一个工具仍在执行");
    await receive({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
      },
    });
    assert.equal(phase(), "waiting_model");
    await receive({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 3,
    });
    assert.equal(phase(), "retrying");
    await receive({ type: "system", subtype: "status", status: "compacting" });
    assert.equal(phase(), "compacting");
    await stream({ type: "message_start" });
    assert.equal(phase(), "waiting_model");
    await stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Done" },
    });
    assert.equal(phase(), "receiving");
    await receive({
      type: "result",
      subtype: "success",
      result: "Done",
      queued_turn_count: 0,
    });
    assert.equal(run.done, true);
    assert.deepEqual(store.activities.list(session.id), []);
    assert.ok(
      run.events.some(
        (e) =>
          e.type === "status" && (e.data as any).activity.phase === "thinking",
      ),
    );
  } finally {
    await manager.translations.shutdown();
    await manager.media.shutdown();
    store.close();
  }
});

test("助手发言默认可见；工具折叠，返回归到对应调用并保留独立翻译入口", () => {
  const block = (
    kind: TraceBlock["kind"],
    original: string,
    extra = {},
  ): TraceBlock => ({
    id: randomUUID(),
    sessionId: "s",
    runId: "r",
    createdAt: new Date().toISOString(),
    kind,
    title: kind === "tool" ? "Read" : "Claude Code 输出",
    original,
    translationState: "none",
    ...extra,
  });
  const html = renderToStaticMarkup(
    createElement(ProcessGroup, {
      blocks: [
        block("commentary", "Visible dialogue"),
        block("tool", "Hidden parameters", { toolId: "t" }),
        block("tool_result", "Hidden tool output", { toolId: "t" }),
        block("commentary", "Second dialogue"),
      ],
      view: "zh",
      onError: () => {},
    }),
  );
  assert.ok(html.includes("Visible dialogue"));
  assert.ok(html.includes("Second dialogue"));
  assert.ok(!html.includes("Hidden parameters"));
  assert.ok(!html.includes("Hidden tool output"));
  assert.equal((html.match(/<details/g) || []).length, 1);
  assert.ok(!html.includes("<details open"));
  assert.match(
    html,
    /process-dialogue[\s\S]*process-tools[\s\S]*process-dialogue/,
  );
  assert.ok(html.includes("翻译为中文"));
});

test(
  "无请求体的删除不发 JSON 类型；兼容旧客户端且保持忙碌会话保护",
  { timeout: 20000 },
  async () => {
    const fake = await fakeServices({ latencyMs: 1200 });
    const server = await startServer(testDirectory(), "", {
      APP_SKIP_SETUP: "1",
      CC_SANDBOX_URL: fake.base,
      CLAUDE_CODE_OAUTH_TOKEN: "test",
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "deepseek-test",
    });
    const realFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    globalThis.fetch = (input, init) => {
      calls.push(init || {});
      return realFetch(
        typeof input === "string" && input.startsWith("/api")
          ? server.base + input.slice(4)
          : input,
        init,
      );
    };
    try {
      const s = await api<any>("/sessions", { repo: "delete-check" });
      assert.equal(
        new Headers(calls.at(-1)?.headers).get("content-type"),
        "application/json",
      );
      await api(`/sessions/${s.id}`, undefined, "DELETE");
      assert.equal(calls.at(-1)?.headers, undefined);
      const old = await api<any>("/sessions", { repo: "delete-check" });
      const legacy = await realFetch(server.base + `/sessions/${old.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
      assert.equal(legacy.status, 200, await legacy.text());
      const running = await api<any>("/sessions", { repo: "busy-check" });
      const { runId } = await api<any>("/messages", {
        sessionId: running.id,
        prompt: "Reply OK",
        mode: "direct",
        downstreamMode: "manual",
      });
      assert.ok(runId);
      const snapshot = await api<any>(`/sessions/${running.id}`);
      assert.equal(
        snapshot.activities.find((a: Activity) => a.scope === "run").phase,
        "waiting_model",
      );
      assert.equal(calls.at(-1)?.headers, undefined);
      const events = await realFetch(
        server.base + `/sessions/${running.id}/events`,
        { signal: AbortSignal.timeout(3000) },
      );
      const reader = events.body!.getReader();
      const first = await reader.read();
      await reader.cancel();
      assert.match(new TextDecoder().decode(first.value), /waiting_model/);
      await assert.rejects(
        api(`/sessions/${running.id}`, undefined, "DELETE"),
        /执行|结束|中断/,
      );
      await (await realFetch(server.base + `/runs/${runId}/events`)).text();
      const translatedSession = await api<any>("/sessions", {
        repo: "translation-status",
      });
      const statusStream = await realFetch(
        server.base + `/sessions/${translatedSession.id}/events`,
        { signal: AbortSignal.timeout(5000) },
      );
      const statusReader = statusStream.body!.getReader();
      let statusWire = "";
      const pump = (async () => {
        while (true) {
          const chunk = await statusReader.read();
          if (chunk.done) break;
          statusWire += new TextDecoder().decode(chunk.value);
        }
      })();
      try {
        const translatedRun = await api<any>("/messages", {
          sessionId: translatedSession.id,
          prompt: "实现一个简单页面",
          mode: "automatic",
          downstreamMode: "messages",
        });
        await (
          await realFetch(server.base + `/runs/${translatedRun.runId}/events`)
        ).text();
        for (let attempt = 0; attempt < 50; attempt++) {
          const state = await api<any>(`/sessions/${translatedSession.id}`);
          if (!state.activities.length) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await statusReader.cancel();
        await pump;
      }
      const phases = statusWire
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .flatMap((line) => JSON.parse(line.slice(6)).activities || []);
      for (const phase of [
        "checking",
        "preparing",
        "sending",
        "waiting_model",
        "receiving",
      ])
        assert.ok(
          phases.some((a) => a.phase === phase),
          phase,
        );
      assert.ok(
        phases.some((a) => a.phase === "translating" && a.scope === "upstream"),
      );
      assert.ok(
        phases.some(
          (a) => a.phase === "translating" && a.scope === "downstream",
        ),
      );
      await api(`/sessions/${running.id}`, undefined, "DELETE");
      const init = fake.controls.find((c) => c.subtype === "initialize");
      assert.ok(init);
      const prompt = String(init.appendSystemPrompt || "");
      assert.ok(prompt.includes("Respond in English"));
      assert.doesNotMatch(
        prompt,
        /translat|localiz|dictionary|i18n|翻译|本地化/i,
      );
      assert.doesNotMatch(
        PAGE_CONTRACT,
        /translat|localiz|dictionary|i18n|翻译|本地化/i,
      );
    } finally {
      globalThis.fetch = realFetch;
      await server.stop();
      await fake.close();
    }
  },
);

test("排队插话未收到消费回执时不结束，合并回执只结束一次且不重发", async () => {
  const store = new Store(testDirectory()),
    manager = new RuntimeManager(store);
  const session = store.create("queued-receipts");
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
    generation: 3,
    startedAt: Date.now(),
    interrupted: false,
    pendingSteering: new Set(["steer-a", "steer-b"]),
  };
  const connection = { session, run, controller: new AbortController() } as any;
  manager.runs.set(run.id, run);
  try {
    await (manager as any).receive(connection, {
      type: "result",
      subtype: "success",
      result: "Initial reply",
      queued_turn_count: 0,
      user_message_uuid: "initial",
    });
    assert.equal(run.done, false);
    assert.equal(run.pendingSteering?.size, 2);
    await (manager as any).receive(connection, {
      type: "result",
      subtype: "success",
      result: "All additions handled",
      queued_turn_count: 0,
      user_message_uuid: "steer-b",
      user_message_uuids: ["initial", "steer-a", "steer-b"],
    });
    assert.equal(run.done, true);
    assert.equal(run.pendingSteering?.size, 0);
    assert.equal(run.events.filter((event) => event.type === "done").length, 1);
  } finally {
    await manager.shutdown();
    store.close();
  }
});
