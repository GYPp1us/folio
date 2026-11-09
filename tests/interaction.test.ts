import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { fakeServices } from "./fake-services.ts";
import { config } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { RuntimeManager } from "../server/runtime.ts";
test("SDK 询问的中文回答先翻译，敏感回答阻止提交，询问保留供用户取消", async () => {
  const fake = await fakeServices();
  const store = new Store(
      mkdtempSync(join(resolve(".runtime"), "interaction-")),
    ),
    manager = new RuntimeManager(store);
  const session = store.create("interaction-test");
  const previous = config.translateUrl;
  config.translateUrl = fake.base;
  let answer: unknown;
  manager.runs.set("run", { sessionId: session.id } as any);
  manager.questions.set("question", {
    runId: "run",
    finish: (r) => {
      answer = r;
      manager.questions.delete("question");
    },
  });
  try {
    await assert.rejects(
      manager.answer("question", {
        allow: true,
        updatedInput: { answers: { "Which address?": "邮箱 a+b@example.com" } },
      }),
      /敏感信息/,
    );
    assert.equal(answer, undefined);
    assert.ok(manager.questions.has("question"));
    await manager.answer("question", {
      allow: true,
      updatedInput: { answers: { "Which layout?": "紧凑布局" } },
    });
    assert.ok(!JSON.stringify(answer).includes("紧凑布局"));
    assert.ok(JSON.stringify(answer).includes("Which layout?"));
    const request = JSON.parse(fake.translations[0].messages[1].content);
    assert.equal(request.current_speaker, "human");
    assert.equal(request.current_message, "紧凑布局");
    assert.ok(!JSON.stringify(fake.translations).includes("a+b@example.com"));
  } finally {
    config.translateUrl = previous;
    store.close();
    await fake.close();
  }
});
