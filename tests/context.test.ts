import { test } from "node:test";
import assert from "node:assert/strict";
import { recentDialogue, thinkingOff } from "../server/translator.ts";
import type { Message } from "../shared/types.ts";
test("翻译只携带最近五轮完整往返、标明双方角色并清除参考内容中的隐私", () => {
  const history: Message[] = [];
  for (let i = 0; i < 7; i++) {
    history.push({
      id: "u" + i,
      role: "user",
      original: "human " + i,
      chinese: "human " + i,
      createdAt: "",
    });
    history.push({
      id: "a" + i,
      role: "assistant",
      original: "Claude reply " + i + (i === 6 ? " a+b@example.com" : ""),
      chinese: "",
      createdAt: "",
    });
  }
  history.push({
    id: "pending",
    role: "user",
    original: "not yet answered",
    chinese: "",
    createdAt: "",
  });
  const context = recentDialogue(history);
  assert.equal(context.length, 5);
  assert.equal(context[0].human, "human 2");
  assert.ok(context[4].claude_code.startsWith("Claude reply 6"));
  assert.ok(!JSON.stringify(context).includes("a+b@example.com"));
  assert.ok(!JSON.stringify(context).includes("not yet answered"));
});
test("翻译的各协议均显式关闭思考，不回退到开启思考", () => {
  assert.deepEqual(thinkingOff("deepseek/deepseek-v4.1-flash", "auto"), {
    thinking: { type: "disabled" },
    reasoning_effort: "none",
  });
  assert.deepEqual(thinkingOff("qwen-test", "auto"), {
    enable_thinking: false,
    think: false,
  });
  assert.deepEqual(thinkingOff("other-model", "openai"), {
    reasoning_effort: "none",
  });
  assert.deepEqual(
    thinkingOff(
      "deepseek/deepseek-v4.1-flash",
      "auto",
      "https://api.commandcode.ai/provider/v1",
    ),
    { reasoning_effort: "off", thinking: { type: "disabled" } },
  );
});
