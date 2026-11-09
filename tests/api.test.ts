import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeServices } from "./fake-services.ts";
mkdirSync(resolve(".runtime"), { recursive: true });
test(
  "真实 SDK 协议：自动发送、敏感拦截、手动划线、usage、模型、插话和中断",
  { timeout: 40000 },
  async () => {
    const fake = await fakeServices({ steeringInterrupt: true });
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts"],
      {
        env: {
          ...process.env,
          PORT: String(port),
          DATA_DIR: mkdtempSync(join(resolve(".runtime"), "live-api-")),
          APP_SKIP_SETUP: "1",
          APP_PASSWORD: "",
          CC_SANDBOX_URL: fake.base,
          CC_SANDBOX_TOKEN: "test",
          CLAUDE_CODE_OAUTH_TOKEN: "test",
          TRANSLATOR_URL: fake.base,
          TRANSLATOR_MODEL: "deepseek-test",
          HOST_SECRET_DO_NOT_FORWARD: "keep-on-host",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const base = `http://127.0.0.1:${port}/api`;
    const request = async (path: string, body?: unknown, method?: string) => {
      const res = await fetch(base + path, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    try {
      await new Promise<void>((r, reject) => {
        const timer = setTimeout(
          () => reject(new Error("start timeout")),
          10000,
        );
        child.stdout.on("data", (c) => {
          if (c.toString().includes("Folio API")) {
            clearTimeout(timer);
            r();
          }
        });
        child.stderr.on("data", () => {});
        child.on("exit", (code) => reject(new Error("server exit " + code)));
      });
      assert.equal(
        (await request("/sessions", { repo: "bad;cmd" })).status,
        400,
      );
      const session = (await request("/sessions", { repo: "actual-test" }))
        .data;
      const caps = await request(`/sessions/${session.id}/capabilities`);
      assert.equal(caps.status, 200);
      assert.equal(caps.data.models[0].value, "default");
      assert.equal(caps.data.controls.length, 30);
      assert.ok(caps.data.permissionModes.includes("auto"));
      const usage = await request(`/sessions/${session.id}/control`, {
        method: "usage",
        args: [{ skipBehaviors: true }],
      });
      assert.equal(usage.status, 200);
      assert.equal(usage.data.result.rate_limits.five_hour.utilization, 20);
      assert.equal(
        (
          await request(`/sessions/${session.id}/control`, {
            method: "constructor",
            args: [],
          })
        ).status,
        404,
      );
      const first = await request("/messages", {
        sessionId: session.id,
        prompt: "实现简单页面",
        mode: "automatic",
      });
      assert.equal(first.status, 200);
      assert.ok(first.data.runId);
      assert.equal(first.data.review, undefined);
      const steer = await request("/messages", {
        sessionId: session.id,
        prompt: "保持布局紧凑",
        mode: "automatic",
        steering: true,
      });
      assert.equal(steer.data.runId, first.data.runId);
      const events = await (
        await fetch(base + `/runs/${first.data.runId}/events`)
      ).text();
      assert.ok(events.includes("插话已排队"));
      assert.ok(events.includes('"type":"done"'));
      assert.ok(!events.includes('"type":"error"'));
      assert.equal(fake.inputs.length, 2);
      assert.equal(fake.inputs[1].priority, "next");
      assert.equal(
        fake.controls.filter((c) => c.subtype === "interrupt").length,
        0,
      );
      const sensitive = await request("/messages", {
        sessionId: session.id,
        prompt: "邮箱 a+b@example.com",
        mode: "automatic",
      });
      assert.ok(sensitive.data.review);
      assert.equal(fake.inputs.length, 2);
      const review = sensitive.data.review;
      await request(
        `/reviews/${review.id}`,
        {
          decisions: review.findings.map((f: { id: string }) => ({
            id: f.id,
            strategy: "placeholder",
          })),
        },
        "PATCH",
      );
      const prepared = await request(`/reviews/${review.id}/prepare`, {});
      assert.equal(prepared.status, 200);
      assert.ok(!prepared.data.english.includes("a+b@example.com"));
      assert.ok(
        !JSON.stringify(fake.translations.at(-1)).includes("a+b@example.com"),
      );
      const invalidated = await request(
        `/reviews/${review.id}`,
        { decisions: [{ id: review.findings[0].id, strategy: "pass" }] },
        "PATCH",
      );
      assert.equal(invalidated.data.status, "review");
      assert.equal(
        (await request("/runs", { reviewId: review.id })).status,
        400,
      );
      const manual = await request("/messages", {
        sessionId: session.id,
        prompt: "项目代号蓝鲸",
        mode: "manual",
      });
      assert.equal(manual.data.review.status, "review");
      const marked = await request(
        `/reviews/${manual.data.review.id}`,
        { manual: { start: 4, end: 6 } },
        "PATCH",
      );
      assert.equal(marked.data.findings[0].value, "蓝鲸");
      assert.equal(
        (await request(`/reviews/${manual.data.review.id}/prepare`, {})).status,
        400,
      );
      const second = await request("/messages", {
        sessionId: session.id,
        prompt: "继续实现",
        mode: "automatic",
      });
      assert.ok(second.data.runId);
      await request(`/runs/${second.data.runId}/interrupt`, {});
      const stopped = await (
        await fetch(base + `/runs/${second.data.runId}/events`)
      ).text();
      assert.ok(stopped.includes("已中断"));
      const config = (await request("/config")).data;
      assert.equal(config.demo, undefined);
      assert.equal(config.translatorReady, true);
      const envelope = JSON.parse(fake.translations[0].messages[1].content);
      assert.equal(envelope.current_speaker, "human");
      assert.equal(fake.translations[0].thinking.type, "disabled");
      assert.equal(fake.translations[0].reasoning_effort, "none");
      assert.ok(
        fake.headers.every(
          (h) => !h["x-ccsb-env"].includes("HOST_SECRET_DO_NOT_FORWARD"),
        ),
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r();
        else child.once("exit", () => r());
      });
      await fake.close();
    }
  },
);
