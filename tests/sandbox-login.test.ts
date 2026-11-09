import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationUrl } from "../server/sandbox-login.ts";
import { loadSettings } from "../server/settings.ts";
import { planRows } from "../shared/usage.ts";
import { fakeServices } from "./fake-services.ts";
import { startServer, testDirectory } from "./server-helper.ts";
const pause = () => new Promise((r) => setTimeout(r, 15));
test("授权链接只接受官方 HTTPS PKCE 地址，套餐窗口兼容新版行格式和旧版字段", () => {
  assert.equal(
    authorizationUrl(
      "https://claude.com.evil.test/authorize?state=a&code_challenge=b",
    ),
    undefined,
  );
  assert.equal(
    authorizationUrl("http://claude.com/authorize?state=a&code_challenge=b"),
    undefined,
  );
  assert.ok(
    authorizationUrl(
      "Open https://claude.com/cai/oauth/authorize?state=a&code_challenge=b",
    ),
  );
  const rows = planRows({
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        resets_at: null,
        scope: { model: { display_name: "Sonnet" } },
        severity: "normal",
      },
    ],
    extra_usage: { utilization: 12 },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].percent, 0);
  assert.equal(rows[0].label, "每周 · Sonnet");
  const legacy = planRows({
    five_hour: { utilization: 32, resets_at: "2026-10-28T10:00:00Z" },
    extra_usage: { utilization: 20 },
  });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].percent, 32);
  assert.equal(
    planRows({ limits: [{ kind: "future_meter", percent: null }] })[0].percent,
    null,
  );
});
test(
  "沙箱网页登录：代码不进消息与日志、按仓库切换 SDK 凭证、重启保留并可取消",
  { timeout: 30000 },
  async () => {
    const fake = await fakeServices({ requiresWebLoginForUsage: true });
    const directory = testDirectory();
    const env = {
      APP_SKIP_SETUP: "1",
      CC_SANDBOX_URL: fake.base,
      CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "test-model",
    };
    let server = await startServer(directory, "", env);
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(server.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const until = async (predicate: (value: any) => boolean) => {
      for (let i = 0; i < 150; i++) {
        const value = (await request("/sandbox/login?repo=auth-test")).data;
        if (predicate(value)) return value;
        await pause();
      }
      throw new Error("Login flow timed out");
    };
    try {
      const session = (await request("/sessions", { repo: "auth-test" })).data;
      assert.equal(
        (
          await request(`/sessions/${session.id}/control`, {
            method: "usage",
            args: [],
          })
        ).data.result.rate_limits_available,
        false,
      );
      const first = (await request("/sandbox/login", { repo: "auth-test" }))
        .data;
      const ready = await until((v) => v.flow?.status === "awaiting");
      assert.equal(
        (await request("/sandbox/login", { repo: "auth-test" })).data.id,
        first.id,
      );
      assert.equal(
        (await request(`/sessions/${session.id}/capabilities`)).status,
        409,
      );
      assert.equal(
        (
          await request("/sandbox/action", {
            repo: "auth-test",
            action: "recreate",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/sandbox/login/code", {
            repo: "auth-test",
            id: ready.flow.id,
            code: "invalid\ncode",
          })
        ).status,
        400,
      );
      const submitted = await request("/sandbox/login/code", {
        repo: "auth-test",
        id: ready.flow.id,
        code: "one-time-code-for-test",
      });
      assert.equal(submitted.status, 200);
      assert.equal(
        (await until((v) => v.flow?.status === "complete")).mode,
        "web",
      );
      const usage = (
        await request(`/sessions/${session.id}/control`, {
          method: "usage",
          args: [],
        })
      ).data.result;
      assert.equal(usage.authentication_mode, "web");
      assert.equal(usage.rate_limits_available, true);
      assert.equal(usage.rate_limits.limits[0].percent, 23);
      const beforeQuota = fake.controls.filter(
        (c) => c.subtype === "get_usage",
      ).length;
      const quota = (await request(`/sessions/${session.id}/quota`)).data;
      assert.equal(quota.rows[0].percent, 23);
      assert.equal(quota.rows[0].resetsAt, "2026-10-28T12:00:00Z");
      await request(`/sessions/${session.id}/quota`);
      await request(`/sessions/${session.id}/quota?refresh=1`);
      assert.equal(
        fake.controls.filter((c) => c.subtype === "get_usage").length,
        beforeQuota + 1,
      );

      const sdkHeaders = fake.headers.filter(
        (h) =>
          h["x-ccsb-repo"] === "auth-test" &&
          JSON.parse(h["x-ccsb-args"]).includes("--input-format"),
      );
      assert.equal(
        JSON.parse(sdkHeaders.at(-1)!["x-ccsb-env"]).CLAUDE_CODE_OAUTH_TOKEN,
        undefined,
      );
      const other = (await request("/sessions", { repo: "other-repo" })).data;
      await request(`/sessions/${other.id}/capabilities`);
      assert.equal(
        JSON.parse(
          fake.headers.filter((h) => h["x-ccsb-repo"] === "other-repo").at(-1)![
            "x-ccsb-env"
          ],
        ).CLAUDE_CODE_OAUTH_TOKEN,
        "test-oauth",
      );
      assert.deepEqual(fake.loginCodes, ["one-time-code-for-test"]);
      assert.equal(fake.translations.length, 0);
      assert.deepEqual(loadSettings(directory).webLoginRepos, ["auth-test"]);
      assert.ok(
        !readFileSync(join(directory, "settings.enc")).includes(
          "one-time-code-for-test",
        ),
      );
      assert.equal(
        (await request(`/sessions/${session.id}`)).data.messages.length,
        0,
      );
      await server.stop();
      server = await startServer(directory, "", env);
      assert.equal(
        (await request("/sandbox/login?repo=auth-test")).data.mode,
        "web",
      );
      assert.equal(
        (
          await request(`/sessions/${session.id}/control`, {
            method: "usage",
            args: [],
          })
        ).data.result.rate_limits_available,
        true,
      );
      await request("/sandbox/login/token", { repo: "auth-test" });
      assert.equal(
        (await request("/sandbox/login?repo=auth-test")).data.mode,
        "token",
      );
      assert.equal(
        (
          await request(`/sessions/${session.id}/control`, {
            method: "usage",
            args: [],
          })
        ).data.result.rate_limits_available,
        false,
      );
      await request("/sandbox/login", { repo: "auth-test" });
      await until((v) => v.flow?.status === "awaiting");
      await request("/sandbox/login/cancel", { repo: "auth-test" });
      assert.equal(
        (await request("/sandbox/login?repo=auth-test")).data.flow.status,
        "cancelled",
      );
      assert.equal(
        (await request(`/sessions/${session.id}/capabilities`)).status,
        200,
      );
    } finally {
      await server.stop();
      await fake.close();
    }
  },
);
