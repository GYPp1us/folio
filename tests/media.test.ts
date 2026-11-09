import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeServices } from "./fake-services.ts";
import { startServer, testDirectory } from "./server-helper.ts";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0YAAAAASUVORK5CYII=",
  "base64",
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "上传原图免检查与翻译、附件真实入卷、直接发送、逐块翻译和执行记录重启恢复",
  { timeout: 30000 },
  async () => {
    const fake = await fakeServices({ trace: true });
    const directory = testDirectory();
    const overrides = {
      APP_SKIP_SETUP: "1",
      CC_SANDBOX_URL: fake.base,
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "deepseek-test",
      CLAUDE_CODE_OAUTH_TOKEN: "test",
    };
    let server = await startServer(directory, "", overrides);
    const request = async (path: string, body?: unknown) => {
      const r = await fetch(server.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const d = await r.json();
      assert.equal(r.status, 200, JSON.stringify(d));
      return d;
    };
    try {
      const session = await request("/sessions", { repo: "media-test" });
      const upload = async (name: string, bytes: Buffer) => {
        const r = await fetch(server.base + `/uploads/${session.id}`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(name),
          },
          body: new Uint8Array(bytes),
        });
        assert.equal(r.status, 200);
        return r.json();
      };
      const photo = await upload("photo.png", png);
      assert.equal(photo.scan, "exempt");
      assert.equal(photo.approval, "ready");
      assert.equal(
        (
          await fetch(server.base + `/assets/${photo.id}/translate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
        400,
      );
      const file = await upload(
        "notes.txt",
        Buffer.from("Contact private@example.com"),
      );
      assert.equal(file.approval, "pending");
      await request(`/assets/${file.id}/decisions`, {
        decisions: file.findings.map((f: any) => ({
          id: f.id,
          strategy: "placeholder",
        })),
      });
      const result = await request("/messages", {
        sessionId: session.id,
        prompt: "请查看 @[photo.png] 和 @[notes.txt]",
        mode: "direct",
        downstreamMode: "messages",
        attachments: [photo.id, file.id],
      });
      await (await fetch(server.base + `/runs/${result.runId}/events`)).text();
      await wait(100);
      const input = fake.inputs[0].message.content;
      assert.ok(Array.isArray(input));
      assert.equal(input[1].source.data, png.toString("base64"));
      assert.ok(input[0].text.includes("请查看"));
      assert.ok(!input[0].text.includes("@[photo.png]"));
      assert.equal(fake.files.size, 2);
      assert.ok([...fake.files.values()].some((b) => b.equals(png)));
      assert.ok(
        [...fake.files.values()].some((b) => b.toString().includes("__YJ_")),
      );
      assert.ok(
        ![...fake.files.values()].some((b) =>
          b.toString().includes("private@example.com"),
        ),
      );
      assert.ok(
        !JSON.stringify(fake.translations).includes("private@example.com"),
      );
      assert.ok(
        !fake.translations.some((r) => Array.isArray(r.messages[1].content)),
      );
      let detail = await request(`/sessions/${session.id}`);
      assert.equal(
        detail.session.usage.model_usage["test-model"].cacheReadInputTokens,
        7,
      );
      assert.equal(
        detail.blocks.find((b: any) => b.kind === "tool").translationState,
        "none",
      );
      assert.equal(
        detail.blocks.find((b: any) => b.kind === "tool_description")
          .translationState,
        "none",
      );
      assert.equal(
        detail.blocks.find((b: any) => b.kind === "tool_result")
          .translationState,
        "none",
      );
      assert.equal(
        detail.blocks.find((b: any) => b.kind === "commentary")
          .translationState,
        "done",
      );
      assert.ok(
        detail.messages.find((m: any) => m.role === "assistant").chinese,
      );
      const tool = detail.blocks.find((b: any) => b.kind === "tool");
      await request(`/blocks/${tool.id}/translate`, {});
      detail = await request(`/sessions/${session.id}`);
      assert.ok(detail.blocks.find((b: any) => b.id === tool.id).chinese);
      const second = await request("/messages", {
        sessionId: session.id,
        prompt: "继续",
        mode: "direct",
        downstreamMode: "manual",
      });
      await (await fetch(server.base + `/runs/${second.runId}/events`)).text();
      detail = await request(`/sessions/${session.id}`);
      assert.ok(
        detail.blocks
          .filter((b: any) => b.runId === second.runId)
          .every((b: any) => b.translationState === "none"),
      );
      assert.equal(
        detail.session.usage.model_usage["test-model"].inputTokens,
        6,
      );
      assert.equal(
        detail.session.usage.model_usage["test-model"].cacheCreationInputTokens,
        22,
      );
      await server.stop();
      server = await startServer(directory, "", overrides);
      detail = await request(`/sessions/${session.id}`);
      assert.equal(detail.assets.length, 2);
      assert.ok(detail.blocks.some((b: any) => b.id === tool.id && b.chinese));
      const restored = await fetch(
        server.base + `/assets/${photo.id}/content?inline=1`,
      );
      assert.deepEqual(Buffer.from(await restored.arrayBuffer()), png);
      const ciphertext = readdirSync(join(directory, "assets"))
        .map((n) => readFileSync(join(directory, "assets", n)))
        .reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
      assert.ok(!ciphertext.includes(Buffer.from("private@example.com")));
      assert.ok(!ciphertext.includes(png));
    } finally {
      await server.stop();
      await fake.close();
    }
  },
);

test(
  "HTML 本地化字典带五轮历史、占位符还原、资源打包与隔离策略",
  { timeout: 20000 },
  async () => {
    const fake = await fakeServices();
    Object.assign(process.env, {
      CC_SANDBOX_URL: fake.base,
      CC_SANDBOX_TOKEN: "test",
      TRANSLATOR_URL: fake.base,
      TRANSLATOR_MODEL: "deepseek-test",
      DATA_DIR: testDirectory(),
    });
    const { Store } = await import("../server/store.ts");
    const { MediaService, previewHtml, HTML_POLICY } =
      await import("../server/media.ts");
    const { config } = await import("../server/config.ts");
    Object.assign(config, {
      sandboxUrl: fake.base,
      token: "test",
      translateUrl: fake.base,
      translateModel: "deepseek-test",
    });
    const store = new Store(testDirectory());
    const session = store.create("page-test");
    session.downstreamMode = "manual";
    store.save(session);
    for (let i = 0; i < 7; i++) {
      store.add(session.id, {
        role: "user",
        original: `request ${i}`,
        chinese: `请求 ${i}`,
      });
      store.add(session.id, {
        role: "assistant",
        original: `response ${i}`,
        chinese: `回复 ${i}`,
      });
    }
    store.add(session.id, {
      role: "user",
      original: "Create a report",
      chinese: "生成报告",
    });
    const files = new Map<string, Buffer>();
    const bridge = {
      write: async (_r: string, p: string, b: Buffer) => {
        files.set(p, b);
      },
      read: async (_r: string, p: string) => {
        const b = files.get(p);
        if (!b) throw Error("not found");
        return b;
      },
    };
    const media = new MediaService(store, bridge);
    const source =
      '<!doctype html><html><head><link rel="stylesheet" href="styles/site.css"><script id="folio-i18n" type="application/json">{"heading":"Report","contact":"private@example.com"}</script></head><body><h1 data-i18n="heading">Report</h1><p data-i18n="contact">private@example.com</p><script>window.testPage=true;</script></body></html>';
    files.set("/work/report.html", Buffer.from(source));
    files.set(
      "/work/styles/site.css",
      Buffer.from("body{background-image:url(../texture.png)}"),
    );
    files.set("/work/texture.png", png);
    try {
      let asset = await media.publish(
        session.id,
        "run-test",
        "/work/report.html",
      );
      assert.equal(asset.translationState, "none");
      assert.ok(asset.previewReady);
      asset = await media.translate(asset.id);
      assert.ok(asset.translatedCatalog?.heading.includes("中文"));
      assert.ok(
        asset.translatedCatalog?.contact.includes("private@example.com"),
      );
      const payload = JSON.parse(fake.translations.at(-1)!.messages[1].content);
      assert.equal(payload.current_kind, "page_catalog");
      assert.equal(payload.recent_conversation.length, 5);
      assert.equal(payload.recent_conversation[0].claude_code, "response 2");
      assert.equal(payload.current_request, "生成报告");
      assert.ok(!JSON.stringify(payload).includes("private@example.com"));
      const bundled = store.derivative(asset.id).toString();
      assert.ok(bundled.includes("data:image/png;base64,"));
      assert.ok(!bundled.includes("styles/site.css"));
      const preview = previewHtml(
        bundled,
        asset.catalog!,
        asset.translatedCatalog,
        "zh",
        {},
      );
      assert.ok(preview.includes("event.source!==parent"));
      assert.ok(
        preview.indexOf("window.folioI18n") <
          preview.indexOf("window.testPage"),
      );
      assert.ok(HTML_POLICY.includes("connect-src 'none'"));
      assert.ok(HTML_POLICY.includes("sandbox allow-scripts"));
      await assert.rejects(
        media.publish(session.id, "r", "/etc/passwd"),
        /工作区/,
      );
      const plainHtml = "<h1>Simple report</h1>";
      files.set("/work/raw.html", Buffer.from(plainHtml));
      const plainAsset = await media.publish(session.id, "r", "/work/raw.html");
      assert.ok(plainAsset.previewReady);
      assert.ok(
        Object.values(plainAsset.catalog || {}).includes("Simple report"),
      );
      assert.equal(files.get("/work/raw.html")!.toString(), plainHtml);
      assert.equal(files.get("/work/report.html")!.toString(), source);
      files.set(
        "/work/remote.html",
        Buffer.from(
          source.replace("styles/site.css", "https://example.com/x.css"),
        ),
      );
      await assert.rejects(
        media.publish(session.id, "r", "/work/remote.html"),
        /本地资源/,
      );
    } finally {
      await media.shutdown();
      store.close();
      await fake.close();
    }
  },
);
