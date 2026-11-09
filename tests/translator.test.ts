import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { config } from "../server/config.ts";
import { translate } from "../server/translator.ts";
test("翻译器冻结代码并拒绝占位符丢失、幻造和残留中文", async () => {
  let responseText = "",
    input = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      input = JSON.parse(JSON.parse(body).messages[1].content).current_message;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: responseText || input.replace("你好", "Hello"),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.translateUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const result = await translate(
      '你好 __YJ_EMAIL_ABC__\n```js\nconst label = "你好";\n```',
      "en",
    );
    assert.ok(!input.includes("const label"));
    assert.ok(result.includes('const label = "你好";'));
    assert.ok(result.includes("__YJ_EMAIL_ABC__"));
    const html = '<div onclick="window.count++"><strong>Hello</strong></div>';
    const htmlResult = await translate("你好 " + html, "en");
    assert.ok(!input.includes("onclick"));
    assert.ok(htmlResult.includes(html));
    responseText = "Hello";
    await assert.rejects(
      translate("你好 __YJ_EMAIL_ABC__", "en"),
      /改变了占位符/,
    );
    responseText = "Hello __YJ_UNKNOWN_FAKE__";
    await assert.rejects(translate("你好", "en"), /未知占位符/);
    responseText = "你好";
    await assert.rejects(translate("你好", "en"), /仍有中文/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
