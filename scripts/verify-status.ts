import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { RuntimeManager } from "../server/runtime.ts";
import { SandboxFiles } from "../server/files.ts";
import { sandbox } from "../server/sandbox.ts";
import type { Review } from "../shared/types.ts";
import { PAGE_CONTRACT } from "../server/media.ts";

// Isolated repo and encrypted database; never touch an owner's working session.
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw new Error("FOLIO_VERIFY_DIR is required");
const store = new Store(directory),
  manager = new RuntimeManager(store);
const repo = "folio-status-check",
  session = store.create(repo);
session.downstreamMode = "manual";
store.save(session);
const source =
  '<!doctype html><html><head><meta charset="utf-8"><title>Status check</title></head><body><h1>Project report</h1><p>Ready for review.</p><button onclick="this.textContent=\'Done\'">Confirm</button></body></html>';
const phases = new Set<string>();
try {
  assert.doesNotMatch(
    PAGE_CONTRACT,
    /translat|localiz|dictionary|i18n|翻译|本地化/i,
  );
  const caps = await manager.capabilities(session.id);
  assert.ok(caps.models.length);
  await new SandboxFiles().write(
    repo,
    "/work/status-check.html",
    Buffer.from(source),
  );
  const prompt =
    'Read /work/status-check.html using Read. Publish that unchanged HTML file using mcp__folio__publish_file with title "Status check". Then reply exactly STATUS_CHECK_OK. Do not run other commands.';
  const review: Review = {
    id: randomUUID(),
    sessionId: session.id,
    original: prompt,
    english: prompt,
    mode: "direct",
    findings: [],
    status: "prepared",
    createdAt: new Date().toISOString(),
  };
  const run = await manager.start(review, {
    model: caps.models.find((m) => m.value === "haiku")?.value || "haiku",
    permissionMode: "auto",
    effort: "off",
    downstreamMode: "manual",
  });
  const onEvent = (event: any) => {
    if (event.data?.activity?.phase) {
      phases.add(event.data.activity.phase);
      console.log("PHASE", event.data.activity.phase);
    }
    if (event.type === "permission" || event.type === "dialog")
      void manager.answer(event.data.id, { allow: true });
  };
  for (const event of run.events) onEvent(event);
  run.listeners.add(onEvent);
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (event: any) => {
        if (event.type === "error" || event.type === "done") {
          run.listeners.delete(finish);
          event.type === "error" ? reject(new Error(event.text)) : resolve();
        }
      };
      timer = setTimeout(
        () => reject(new Error("Native SDK verification timed out")),
        150000,
      );
      run.listeners.add(finish);
      if (run.done) finish(run.events.at(-1));
    });
  } finally {
    clearTimeout(timer!);
    run.listeners.delete(onEvent);
  }
  assert.ok(
    store
      .messages(session.id)
      .some(
        (m) => m.role === "assistant" && m.original.includes("STATUS_CHECK_OK"),
      ),
  );
  assert.ok(phases.has("waiting_model"));
  assert.ok(phases.has("waiting_tool"));
  assert.ok(phases.has("receiving"));
  const page = store.assets(session.id).find((a) => a.kind === "html");
  assert.ok(
    page?.previewReady,
    "CC should publish ordinary HTML without a model-supplied catalog",
  );
  assert.equal(store.assetBytes(page.id).toString(), source);
  assert.ok(Object.values(page.catalog || {}).includes("Project report"));
  assert.deepEqual(store.activities.list(session.id), []);
  await manager.media.translate(page.id);
  assert.ok(
    Object.values(store.asset(page.id)!.translatedCatalog || {}).some((v) =>
      /\p{Script=Han}/u.test(v),
    ),
  );
  assert.equal(
    (await new SandboxFiles().read(repo, "/work/status-check.html")).toString(),
    source,
  );
  assert.deepEqual(store.activities.list(session.id), []);
  console.log(
    JSON.stringify({
      nativeSdk: true,
      phases: [...phases],
      ordinaryHtmlPublished: true,
      internalPageTranslation: true,
      sourcePreserved: true,
    }),
  );
} finally {
  await manager.shutdown();
  store.close();
  await sandbox("/sandbox/stop", "POST", { repo });
  assert.equal(
    ((await sandbox("/sandbox/status?repo=" + repo)) as any).running,
    false,
  );
  console.log("PASS: dedicated status sandbox stopped; test volumes retained");
}
