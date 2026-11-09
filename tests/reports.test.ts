import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import {
  Reports,
  reportHtml,
  reportPolicy,
  validReportPath,
} from "../server/reports.ts";
import { testDirectory, startServer } from "./server-helper.ts";
import { fakeServices } from "./fake-services.ts";
import { translateInteraction } from "../server/interaction.ts";
import { config } from "../server/config.ts";

test("发布快照独立于会话并加密保存；路径和总大小受限", async () => {
  const directory = testDirectory(),
    store = new Store(directory),
    reports = new Reports(store),
    session = store.create("report-test");
  const base = {
    id: randomUUID(),
    title: "Report",
    repo: session.repo,
    sessionId: session.id,
    kind: "static" as const,
    createdAt: new Date().toISOString(),
    state: "ready" as const,
    entry: "index.html",
  };
  try {
    const report = reports.snapshot(base, {
      "index.html": Buffer.from(
        "<h1>confidential-report-example</h1>",
      ).toString("base64"),
      "app.js": Buffer.from("window.ready=true").toString("base64"),
    });
    assert.equal(report.files?.["app.js"].mime, "text/javascript");
    const largePage = "<p>Visible original content</p>".repeat(501);
    assert.equal(reports.servicePage(report, largePage, "en"), largePage);
    store.remove(session.id);
    assert.equal(reports.get(report.id).id, report.id);
    assert.match(
      reports.read(report, "index.html").toString(),
      /confidential-report-example/,
    );
    for (const file of readdirSync(join(directory, "reports", report.id)))
      assert.ok(
        !readFileSync(
          join(directory, "reports", report.id, file),
          "utf8",
        ).includes("confidential-report-example"),
      );
    assert.throws(() => reports.read(report, "../vault.key"));
    assert.throws(() =>
      reports.snapshot(
        { ...base, id: randomUUID() },
        { "../index.html": "YQ==" },
      ),
    );
    assert.throws(() =>
      reports.snapshot(
        { ...base, id: randomUUID() },
        { "index.html": Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") },
      ),
    );
    await reports.remove(report.id);
    assert.throws(() => reports.get(report.id));
  } finally {
    store.close();
  }
});

test(
  "同域展示需要登录授权，能力仅限指定报告；重启撤销展示凭证",
  { timeout: 20000 },
  async () => {
    const directory = testDirectory(),
      store = new Store(directory),
      reports = new Reports(store),
      session = store.create("private-report");
    const report = reports.snapshot(
      {
        id: randomUUID(),
        title: "Private",
        repo: session.repo,
        sessionId: session.id,
        kind: "static",
        createdAt: new Date().toISOString(),
        state: "ready",
        entry: "index.html",
      },
      {
        "index.html": Buffer.from(
          '<h1>Private report</h1><script src="/app.js"></script>',
        ).toString("base64"),
        "app.js": Buffer.from("window.loaded=true").toString("base64"),
      },
    );
    // Let the intentionally unconfigured translation settle before reopening the DB in the server.
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.close();
    let server = await startServer(directory, "", {
      APP_PASSWORD: "test-report-password",
      APP_SKIP_SETUP: "1",
    });
    try {
      assert.equal((await fetch(server.base + "/reports")).status, 401);
      const login = await fetch(server.base + "/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-report-password" }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const view = await fetch(server.base + `/reports/${report.id}/view`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(view.status, 200);
      const { src } = await view.json();
      const origin = server.base.slice(0, -4);
      const content = await fetch(origin + src);
      assert.equal(content.status, 200);
      assert.match(
        content.headers.get("content-security-policy")!,
        /sandbox allow-scripts allow-forms allow-downloads/,
      );
      assert.ok(
        !content.headers
          .get("content-security-policy")!
          .includes("allow-same-origin"),
      );
      assert.equal(content.headers.get("access-control-allow-origin"), "null");
      assert.match(await content.text(), /<base href=/);
      assert.equal((await fetch(origin + src + "app.js")).status, 200);
      assert.equal(
        (await fetch(origin + src.replace(report.id, randomUUID()))).status,
        401,
      );
      assert.equal((await fetch(origin + src + "vault.key")).status, 404);
      assert.equal(
        (await fetch(origin + `/report/${report.id}/content/invalid/`)).status,
        401,
      );
      await server.stop();
      server = await startServer(directory, "", {
        APP_PASSWORD: "test-report-password",
        APP_SKIP_SETUP: "1",
      });
      assert.equal((await fetch(server.base.slice(0, -4) + src)).status, 401);
    } finally {
      await server.stop();
    }
  },
);

test("发布 HTML 的相对路径与根路径归于当前能力前缀，隔离策略不授予同源能力", () => {
  const base = "/report/id/content/scoped/",
    html = reportHtml(
      '<html><head><base href="https://evil.invalid/"><script type="module" src="/app.js"></script></head><body><img src="images/a.png"><a href="/next">next</a></body></html>',
      base,
    );
  assert.ok(!html.includes("evil.invalid"));
  assert.match(html, /src="\/report\/id\/content\/scoped\/app.js"/);
  assert.match(html, /src="images\/a.png"/);
  const policy = reportPolicy("https://folio.example.com", base);
  assert.ok(!policy.includes("allow-same-origin"));
  assert.match(policy, /worker-src 'none'/);
  for (const path of [
    "../secret",
    "/etc/passwd",
    "a/../secret",
    "a\\b",
    "a//b",
    "a\0b",
  ])
    assert.equal(validReportPath(path), false);
  assert.equal(validReportPath("assets/app.js"), true);
});

test("Agent 问题下传翻译正文和选项，不改变 SDK 问题键与选项值", async () => {
  const fake = await fakeServices(),
    store = new Store(testDirectory()),
    session = store.create("question-report");
  const saved = {
    translateUrl: config.translateUrl,
    translateModel: config.translateModel,
  };
  config.translateUrl = fake.base;
  config.translateModel = "test";
  const data = {
    input: {
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "Use React" },
            { label: "Plain HTML", description: "No framework" },
          ],
        },
      ],
    },
  };
  const before = JSON.stringify(data);
  try {
    const display = await translateInteraction(store, session.id, data);
    assert.match(display.q0, /中文/);
    assert.match(display.o0_1, /中文/);
    assert.match(display.d0_0, /中文/);
    assert.equal(JSON.stringify(data), before);
    assert.ok(
      fake.translations[0].messages[0].content.includes("Simplified Chinese"),
    );
  } finally {
    Object.assign(config, saved);
    store.close();
    await fake.close();
  }
});
