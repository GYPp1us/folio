import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, testDirectory } from "./server-helper.ts";
import { hashPassword, verifyPassword } from "../server/settings.ts";

test(
  "首次安装必须认领，完成后安装码失效；配置加密持久并支持重启登录",
  { timeout: 30000 },
  async () => {
    const directory = testDirectory(),
      installCode = "test-install-code-not-a-real-credential",
      password = "test-access-password-123";
    let server = await startServer(directory, installCode);
    let cookie = "";
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(server.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const received = response.headers.get("set-cookie");
      if (received) cookie = received.split(";")[0];
      return { status: response.status, data: await response.json() };
    };
    try {
      const status = await request("/setup/status");
      assert.equal(status.data.required, true);
      assert.equal(status.data.unlocked, false);
      assert.equal(status.data.defaults, undefined);
      assert.equal((await request("/config")).status, 428);
      assert.equal((await request("/setup/complete", {})).status, 401);
      assert.equal((await request("/auth", { password: "" })).status, 401);
      assert.equal(
        (await request("/setup/unlock", { code: "wrong" })).status,
        401,
      );
      assert.equal(
        (await request("/setup/unlock", { code: installCode })).status,
        200,
      );
      assert.equal((await request("/setup/status")).data.unlocked, true);
      const body = {
        oauthToken: "test-oauth-do-not-store-plaintext",
        translatorUrl: "https://translator.invalid/v1",
        translatorModel: "test-translator",
        translatorKey: "test-api-key",
        password,
        retentionDays: 17,
        repo: "first-workspace",
      };
      assert.equal(
        (await request("/setup/complete", { ...body, password: "short" }))
          .status,
        400,
      );
      const completed = await request("/setup/complete", body);
      assert.equal(completed.status, 200);
      assert.equal(completed.data.session.repo, "first-workspace");
      assert.equal((await request("/setup/status")).data.required, false);
      assert.equal(
        (await request("/setup/unlock", { code: installCode })).status,
        409,
      );
      const cipher = readFileSync(join(directory, "settings.enc"));
      for (const secret of [password, body.oauthToken, body.translatorKey])
        assert.ok(!cipher.includes(Buffer.from(secret)));
      await server.stop();
      cookie = "";
      server = await startServer(directory, installCode);
      assert.equal((await request("/setup/status")).data.required, false);
      assert.equal((await request("/config")).status, 401);
      assert.equal(
        (await request("/auth", { password: installCode })).status,
        401,
      );
      assert.equal((await request("/auth", { password })).status, 200);
      const config = (await request("/config")).data;
      assert.equal(config.retentionDays, 17);
      assert.equal(config.oauthConfigured, true);
      assert.equal(config.translator, "test-translator");
      assert.ok(!JSON.stringify(config).includes(body.oauthToken));
      assert.ok(!JSON.stringify(config).includes(body.translatorKey));
      assert.equal(
        (await request("/sessions")).data[0].repo,
        "first-workspace",
      );
      assert.equal((await request("/setup/complete", body)).status, 409);
    } finally {
      await server.stop();
    }
  },
);
test("访问密码使用加盐 scrypt，错误密码无法通过", async () => {
  const first = await hashPassword("a-long-test-password"),
    second = await hashPassword("a-long-test-password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-long-test-password", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});
