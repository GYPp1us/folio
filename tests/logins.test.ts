import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, testDirectory } from "./server-helper.ts";
test(
  "多个设备登录互不抢占，重启保留，退出只撤销当前设备且不落盘原始 Cookie",
  { timeout: 20000 },
  async () => {
    const directory = testDirectory(),
      password = "test-persistent-devices";
    const settings = { APP_PASSWORD: password, APP_SKIP_SETUP: "1" };
    let server = await startServer(directory, "", settings);
    const login = async () => {
      const response = await fetch(server.base + "/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      assert.equal(response.status, 200);
      const header = response.headers.get("set-cookie")!;
      assert.match(header, /Max-Age=2592000/);
      return header.split(";")[0];
    };
    const auth = async (cookie: string) =>
      (
        await (
          await fetch(server.base + "/auth", { headers: { cookie } })
        ).json()
      ).loggedIn;
    try {
      const [a, b] = await Promise.all([login(), login()]);
      assert.notEqual(a, b);
      assert.equal(await auth(a), true);
      assert.equal(await auth(b), true);
      for (const filename of readdirSync(directory).filter((name) =>
        name.includes("sqlite"),
      )) {
        const bytes = readFileSync(join(directory, filename));
        assert.ok(!bytes.includes(a.split("=")[1]));
        assert.ok(!bytes.includes(b.split("=")[1]));
      }
      const instance = (await (await fetch(server.base + "/health")).json())
        .instance;
      await server.stop();
      server = await startServer(directory, "", settings);
      assert.notEqual(
        (await (await fetch(server.base + "/health")).json()).instance,
        instance,
      );
      assert.equal(await auth(a), true);
      assert.equal(await auth(b), true);
      assert.equal(
        (await fetch(server.base + "/sessions", { headers: { cookie: a } }))
          .status,
        200,
      );
      const logout = await fetch(server.base + "/auth/logout", {
        method: "POST",
        headers: { cookie: a },
      });
      assert.equal(logout.status, 200);
      assert.equal(await auth(a), false);
      assert.equal(await auth(b), true);
      await server.stop();
      server = await startServer(directory, "", {
        ...settings,
        APP_PASSWORD: "changed-device-password",
      });
      assert.equal(await auth(b), false);
    } finally {
      await server.stop();
    }
  },
);
