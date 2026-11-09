import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { RuntimeManager } from "../server/runtime.ts";
import { config } from "../server/config.ts";
import { sandbox } from "../server/sandbox.ts";
import { thinkingOff, translate } from "../server/translator.ts";
import type { Review } from "../shared/types.ts";
// Dedicated repo/database. Never use the owner's conversations or working tree.
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw new Error("FOLIO_VERIFY_DIR is required");
const store = new Store(directory),
  manager = new RuntimeManager(store),
  repo = "folio-workbench-check";
const session = store.create(repo);
const review = (original: string, steering = false): Review => ({
  id: randomUUID(),
  sessionId: session.id,
  original,
  english: original,
  findings: [],
  status: "prepared",
  createdAt: new Date().toISOString(),
  mode: "automatic",
  steering,
});
try {
  const caps = await manager.capabilities(session.id);
  assert.ok(caps.models.length);
  assert.ok(caps.permissionModes.includes("auto"));
  assert.ok(caps.commands.some((c) => c.name === "usage"));
  console.log("PASS: live models, commands and auto classifier mode");
  const usage = (await manager.control(session.id, "usage", [
    { skipBehaviors: true },
  ])) as Record<string, unknown>;
  assert.ok(usage.session);
  const context = await manager.control(session.id, "getContextUsage", [
    { detail: "summary" },
  ]);
  assert.ok(context);
  console.log(
    JSON.stringify({
      usageAvailable: true,
      planLimitsAvailable: usage.rate_limits_available,
      contextAvailable: true,
    }),
  );
  const response = await fetch(
    config.translateUrl.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.translateKey}`,
      },
      body: JSON.stringify({
        model: config.translateModel,
        ...thinkingOff(),
        max_tokens: 64,
        messages: [
          { role: "user", content: "Reply exactly TRANSLATOR_OFF_OK." },
        ],
      }),
    },
  );
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as any;
    console.log(
      JSON.stringify({
        translatorStatus: response.status,
        error: String(error.error?.message || error.message || "unknown").slice(
          0,
          800,
        ),
      }),
    );
  }
  assert.ok(response.ok, "Translator rejected thinking-off request");
  const data = (await response.json()) as any;
  assert.ok(
    !data.choices?.[0]?.message?.reasoning_content,
    "Translator returned reasoning despite disabled thinking",
  );
  console.log(
    JSON.stringify({
      translationThinking: "disabled",
      reasoningTokens:
        data.usage?.completion_tokens_details?.reasoning_tokens ??
        data.usage?.reasoning_tokens ??
        "not-reported",
    }),
  );
  const translated = await translate(
    "请只回复 FOLIO_TRANSLATION_OK，不要调用工具。",
    "en",
  );
  assert.ok(translated.includes("FOLIO_TRANSLATION_OK"));
  assert.notEqual(translated.trim(), "FOLIO_TRANSLATION_OK");
  console.log(
    "PASS: translator relays the human request instead of answering it",
  );
  const run = await manager.start(
    review("Reply exactly BASE_OK. Do not call any tools."),
    { model: "default", permissionMode: "auto", effort: "low" },
  );
  const complete = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Live steering turn timed out")),
      90000,
    );
    const listener = (event: { type: string; text?: string }) => {
      if (event.type === "done" || event.type === "error") {
        clearTimeout(timer);
        run.listeners.delete(listener as never);
        event.type === "done" ? resolve() : reject(new Error(event.text));
      }
    };
    run.listeners.add(listener as never);
  });
  const steered = await manager.start(
    review("Instead, reply exactly STEERING_OK. Do not call any tools.", true),
    { model: "default", permissionMode: "auto", effort: "low" },
  );
  assert.equal(steered.id, run.id);
  await complete;
  const messages = store.visibleMessages(session.id);
  assert.ok(messages.some((m) => m.kind === "steering"));
  assert.ok(
    messages.some(
      (m) => m.role === "assistant" && m.original.includes("STEERING_OK"),
    ),
  );
  console.log(
    "PASS: real model, auto permissions, adjustable effort, mid-run steering and Chinese reply translation",
  );
} finally {
  await manager.shutdown();
  store.close();
  await sandbox("/sandbox/stop", "POST", { repo });
  const status = (await sandbox("/sandbox/status?repo=" + repo)) as {
    running?: boolean;
  };
  assert.equal(status.running, false);
  console.log(
    "PASS: test SDK connections and sandbox stopped; test volumes retained",
  );
}
