import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTokens, mergeUsage, sandboxTokens } from "../shared/usage.ts";
import { richParts, replaceRich, safeImageUrl } from "../shared/rich.ts";
import { autoTranslate } from "../server/translations.ts";
import { Store } from "../server/store.ts";
import { testDirectory, startServer } from "./server-helper.ts";
import { fakeServices } from "./fake-services.ts";
import { localizeInline, svgForRaster } from "../server/media.ts";

test("累计 token 包含缓存与多个模型；连续快照、重连和异常结果不会重复或清零", () => {
  const a = {
    model_usage: {
      main: {
        inputTokens: 10,
        outputTokens: 20,
        thinkingTokens: 7,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
    },
  };
  const b = {
    model_usage: {
      main: {
        inputTokens: 15,
        outputTokens: 25,
        cacheReadInputTokens: 35,
        cacheCreationInputTokens: 45,
      },
      sub: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    },
  };
  const merged = mergeUsage(a, b);
  assert.deepEqual(sessionTokens(merged).totals, {
    input: 16,
    output: 27,
    cacheRead: 38,
    cacheWrite: 49,
    total: 130,
  });
  assert.equal(sessionTokens(mergeUsage(merged, b)).totals.total, 130);
  assert.equal(
    sessionTokens(mergeUsage(merged, { model_usage: {} })).totals.total,
    130,
  );
  assert.equal(sessionTokens({}, merged).totals.total, 130);
  assert.equal(sessionTokens().totals.total, null);
  assert.equal(
    sessionTokens({ model_usage: { unknown: { inputTokens: 1 } } }).totals
      .total,
    null,
  );
});
test("默认翻译对话回复；迁移旧版全部翻译只执行一次并保留手动模式", () => {
  for (const kind of [
    "tool",
    "tool_result",
    "tool_description",
    "thinking",
  ] as const)
    assert.equal(autoTranslate(kind, "messages"), false);
  assert.equal(autoTranslate("final", "messages"), true);
  assert.equal(autoTranslate("commentary", "messages"), true);
  assert.equal(autoTranslate("tool", "all"), true);
  const dir = testDirectory();
  let store = new Store(dir);
  const old = store.create("default-test"),
    manual = store.create("manual-test");
  assert.equal(old.downstreamMode, "messages");
  store.save({ ...old, downstreamMode: "all" });
  store.save({ ...manual, downstreamMode: "manual" });
  store.db.prepare("DELETE FROM app_meta WHERE id=?").run("reply-default-v2");
  store.close();
  store = new Store(dir);
  assert.equal(store.session(old.id)?.downstreamMode, "messages");
  assert.equal(store.session(manual.id)?.downstreamMode, "manual");
  store.save({ ...old, downstreamMode: "all" });
  store.close();
  store = new Store(dir);
  assert.equal(store.session(old.id)?.downstreamMode, "all");
  store.close();
});
test("Markdown 与 HTML 解析区分代码和预览，SVG/HTML 本地化保持脚本与结构", () => {
  const text =
    'Report\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><text>Start</text></svg>\n```\n\nInline <span style="color:red">hello</span> end\n\n```js\nconst html="<div>code</div>";\n```';
  const parts = richParts(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].kind, "svg");
  assert.equal(parts[1].source, '<span style="color:red">hello</span>');
  assert.ok(
    replaceRich(text, parts, (_p, i) => `[preview ${i}]`).includes(
      'const html="<div>code</div>"',
    ),
  );
  assert.equal(richParts("```html\n<div>partial").length, 0);
  assert.equal(safeImageUrl("javascript:alert(1)"), false);
  assert.equal(safeImageUrl("data:text/html,evil"), false);
  assert.equal(safeImageUrl("data:image/svg+xml;base64,PHN2Zz4="), true);
  const page = localizeInline(
    '<div><strong>Hello</strong><button onclick="window.count++">Add item</button></div>',
  );
  assert.ok(Object.values(page.catalog).includes("Hello"));
  assert.ok(page.html.includes('onclick="window.count++"'));
  assert.ok(page.html.includes("data-i18n="));
  const raster = svgForRaster(
    '<!DOCTYPE svg [<!ENTITY leak SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="file:///etc/passwd"/><style>rect{fill:url(file:///tmp/x)}</style><rect width="20" height="20"/></svg>',
  );
  assert.ok(!raster.includes("<script"));
  assert.ok(!raster.includes("foreignObject"));
  assert.ok(!raster.includes("file:///"));
  assert.ok(raster.includes("<rect"));
});
test(
  "行内 HTML/SVG/图片通过私有资产预览、去重与重启恢复；越界路径被拒绝",
  { timeout: 20000 },
  async () => {
    const fake = await fakeServices(),
      dir = testDirectory();
    let server = await startServer(dir, "", {
      APP_SKIP_SETUP: "1",
      CC_SANDBOX_URL: fake.base,
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "deepseek-test",
    });
    const request = async (path: string, body?: unknown) => {
      const r = await fetch(server.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: r.status,
        data: r.headers.get("content-type")?.includes("application/json")
          ? await r.json()
          : await r.text(),
        headers: r.headers,
      };
    };
    try {
      const session = (await request("/sessions", { repo: "inline-test" }))
        .data;
      await request(`/sessions/${session.id}/preferences`, {
        downstreamMode: "manual",
      });
      const body = {
        sessionId: session.id,
        kind: "html",
        source:
          "<div><h2>Hello</h2><button onclick=\"this.textContent='Clicked'\">Click</button></div>",
      };
      const [a, b] = await Promise.all([
        request("/inline", body),
        request("/inline", body),
      ]);
      assert.equal(a.status, 200);
      assert.equal(a.data.id, b.data.id);
      assert.ok(a.data.previewReady);
      const preview = await request(`/assets/${a.data.id}/preview`);
      assert.equal(preview.status, 200);
      assert.ok(
        preview.headers
          .get("content-security-policy")
          ?.includes("sandbox allow-scripts"),
      );
      assert.ok(
        preview.headers
          .get("content-security-policy")
          ?.includes("connect-src 'none'"),
      );
      const svg = await request("/inline", {
        sessionId: session.id,
        kind: "svg",
        source:
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>',
      });
      assert.equal(svg.data.mime, "image/svg+xml");
      const image = await request("/inline", {
        sessionId: session.id,
        kind: "image",
        source:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0YAAAAASUVORK5CYII=",
      });
      assert.equal(image.status, 200);
      assert.equal(image.data.kind, "image");
      assert.equal(
        (
          await request("/inline", {
            sessionId: session.id,
            kind: "image",
            source: "/etc/passwd",
          })
        ).status,
        400,
      );
      assert.equal(
        (await request(`/assets/${svg.data.id}/content`)).headers.get(
          "content-type",
        ),
        "application/octet-stream",
      );
      assert.equal(fake.translations.length, 0);
      await server.stop();
      server = await startServer(dir, "", {
        APP_SKIP_SETUP: "1",
        CC_SANDBOX_URL: fake.base,
        TRANSLATOR_URL: fake.base,
        TRANSLATOR_MODEL: "deepseek-test",
      });
      assert.equal((await request("/inline", body)).data.id, a.data.id);
      assert.ok(
        (await request(`/assets/${a.data.id}/preview`)).data.includes(
          "folio-preview-size",
        ),
      );
    } finally {
      await server.stop();
      await fake.close();
    }
  },
);

test("沙箱用量合计不同会话，按 SDK 会话去重，缓存与未同步范围明确", () => {
  const usage = (n: number) => ({
    model_usage: {
      main: {
        inputTokens: n,
        outputTokens: n * 2,
        cacheReadInputTokens: n * 3,
        cacheCreationInputTokens: n * 4,
      },
    },
  });
  const a = { id: "a", sdkSessionId: "same", usage: usage(10) },
    duplicate = { id: "duplicate", sdkSessionId: "same", usage: usage(11) },
    b = { id: "b", sdkSessionId: "other", usage: usage(1) },
    unused = { id: "empty" };
  const summary = sandboxTokens([a, b, duplicate, unused]);
  assert.equal(summary.sessionCount, 4);
  assert.equal(summary.totals.total, 120);
  assert.equal(summary.pendingSessions, 0);
  assert.equal(summary.totals.cacheRead, 36);
  assert.equal(sessionTokens(a.usage).totals.total, 100);
  const partial = sandboxTokens([
    a,
    b,
    duplicate,
    unused,
    { id: "pending", sdkSessionId: "unreported" },
  ]);
  assert.equal(partial.totals.total, null);
  assert.equal(partial.knownTotals.total, 120);
  assert.equal(partial.pendingSessions, 1);
  assert.equal(sandboxTokens([]).totals.total, 0);
});

test(
  "沙箱统计 API 只汇总所选仓库，保留当前会话独立计数",
  { timeout: 15000 },
  async () => {
    const dir = testDirectory(),
      store = new Store(dir);
    const a = store.create("usage-repo"),
      b = store.create("usage-repo"),
      other = store.create("other-repo");
    const usage = (n: number) => ({
      model_usage: {
        main: {
          inputTokens: n,
          outputTokens: n,
          cacheReadInputTokens: n,
          cacheCreationInputTokens: n,
        },
      },
    });
    store.save({ ...a, sdkSessionId: "sdk-a", usage: usage(10) });
    store.save({ ...b, sdkSessionId: "sdk-b", usage: usage(20) });
    store.save({ ...other, sdkSessionId: "sdk-c", usage: usage(500) });
    store.close();
    const server = await startServer(dir, "", { APP_SKIP_SETUP: "1" });
    try {
      const all = await (
        await fetch(server.base + "/sandbox/usage?repo=usage-repo")
      ).json();
      assert.equal(all.sessionCount, 2);
      assert.equal(all.totals.total, 120);
      const current = await (
        await fetch(server.base + `/sessions/${a.id}`)
      ).json();
      assert.equal(sessionTokens(current.session.usage).totals.total, 40);
      assert.equal(
        (
          await (
            await fetch(server.base + "/sandbox/usage?repo=missing")
          ).json()
        ).sessionCount,
        0,
      );
      assert.equal(
        (await fetch(server.base + "/sandbox/usage?repo=bad%3Bname")).status,
        400,
      );
    } finally {
      await server.stop();
    }
  },
);
