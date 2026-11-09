import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  detect,
  protect,
  materialize,
  restore,
  maskOutput,
} from "../server/privacy.ts";
import { DEMO_PROMPT } from "./fixtures.ts";
import { Store } from "../server/store.ts";
mkdirSync(resolve(".runtime"), { recursive: true });

test("本地发现中文姓名、邮箱与电话；重复值共用一个决定", () => {
  const f = detect(DEMO_PROMPT + "\n再联系 lin.xiao@example.com");
  assert.deepEqual(
    f.map((f) => f.kind),
    ["PERSON", "EMAIL", "PHONE"],
  );
  for (const item of f)
    assert.equal(DEMO_PROMPT.slice(item.start, item.end), item.value);
  const masked = protect(DEMO_PROMPT + "\nlin.xiao@example.com", f);
  for (const item of f) assert.ok(!masked.includes(item.value));
  assert.equal(masked.split(f[1].token).length - 1, 2);
});
test("只在翻译后还原已批准透传的值；ENV 引用和占位符可逆", () => {
  const f = detect(DEMO_PROMPT);
  f[0].strategy = "placeholder";
  f[1].strategy = "pass";
  f[2].strategy = "env";
  const masked = protect(DEMO_PROMPT, f),
    send = materialize(masked, f);
  assert.ok(!masked.includes("lin.xiao@example.com"));
  assert.ok(send.includes("lin.xiao@example.com"));
  assert.ok(!send.includes("13800138000"));
  assert.ok(send.includes("${" + f[2].envName + "}"));
  assert.equal(restore(maskOutput(send, f), f), DEMO_PROMPT);
});
test("高风险凭证、重叠项与正则特殊字符按字面处理", () => {
  const input =
    "api_key=sk-ant-abcdefghijklmnop 邮箱 a+b@example.com IP 192.168.1.2";
  const f = detect(input);
  assert.equal(f.filter((f) => f.secret).length, 1);
  assert.equal(f.find((f) => f.kind === "EMAIL")?.value, "a+b@example.com");
  assert.equal(restore(protect(input, f), f), input);
  const connection = detect(
    "数据库 postgres://admin:secret@example.com:5432/app",
  );
  assert.equal(connection.length, 1);
  assert.equal(connection[0].kind, "URL_CREDENTIAL");
  assert.equal(connection[0].secret, true);
});
test("加密会话与映射可跨重启恢复，磁盘不含原始隐私", () => {
  const directory = mkdtempSync(join(resolve(".runtime"), "store-test-"));
  const store = new Store(directory),
    s = store.create("recovery-test");
  s.sdkSessionId = "sdk-session-id";
  store.save(s);
  store.add(s.id, {
    role: "user",
    original: "lin.xiao@example.com",
    chinese: "林晓",
  });
  store.bind(s.id, detect(DEMO_PROMPT));
  store.close();
  const reopened = new Store(directory);
  assert.equal(reopened.session(s.id)?.sdkSessionId, "sdk-session-id");
  assert.equal(reopened.messages(s.id)[0].chinese, "林晓");
  assert.equal(reopened.bindings(s.id).length, 3);
  reopened.close();
  assert.ok(
    !readFileSync(join(directory, "workspace.sqlite")).includes(
      Buffer.from("lin.xiao@example.com"),
    ),
  );
});
