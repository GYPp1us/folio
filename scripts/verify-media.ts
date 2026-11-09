import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { Store } from "../server/store.ts";
import { RuntimeManager } from "../server/runtime.ts";
import { SandboxFiles } from "../server/files.ts";
import { config } from "../server/config.ts";
import { sandbox } from "../server/sandbox.ts";
import { translateImage } from "../server/translator.ts";
import type { Review } from "../shared/types.ts";
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw Error("FOLIO_VERIFY_DIR required");
const repo = "folio-media-check",
  store = new Store(directory),
  runtime = new RuntimeManager(store),
  files = new SandboxFiles();
const session = store.create(repo);
session.downstreamMode = "all";
store.save(session);
try {
  await sandbox("/sandbox/start", "POST", { repo });
  const bytes = await sharp(
    Buffer.from(
      '<svg width="320" height="140"><rect width="320" height="140" fill="white"/><text x="35" y="80" font-size="30">START</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const upload = runtime.media.upload(session.id, "input.png", bytes);
  assert.equal(upload.scan, "exempt");
  await runtime.media.prepareInputs(session.id, [upload.id]);
  assert.equal(
    createHash("sha256")
      .update(
        await files.read(
          repo,
          upload.sandboxPath || runtime.media.get(upload.id).sandboxPath!,
        ),
      )
      .digest("hex"),
    upload.digest,
  );
  await assert.rejects(files.read(repo, "/etc/passwd"));
  console.log(
    "PASS: encrypted upload, byte-exact sandbox file bridge and path restriction",
  );
  // Generated synthetic image only; uploaded user images never enter this probe.
  const candidates = [
    config.visionModel || config.translateModel,
    "google/gemini-3.5-flash-lite",
  ];
  let vision = "";
  for (const model of [...new Set(candidates)]) {
    config.visionModel = model;
    try {
      const description = await translateImage(
        bytes,
        "image/png",
        "Describe the generated diagram and translate any readable labels.",
        [],
      );
      assert.ok(description.description_zh);
      assert.match(
        description.description_en + description.description_zh,
        /START|开始/i,
      );
      vision = model;
      console.log(
        JSON.stringify({ visionModel: model, syntheticImageTranslated: true }),
      );
      break;
    } catch (error) {
      console.log(
        JSON.stringify({
          visionModel: model,
          syntheticImageTranslated: false,
          reason: String((error as Error).message).slice(0, 160),
        }),
      );
    }
  }
  assert.ok(vision, "No usable configured vision model");
  const generated = await sharp(
    Buffer.from(
      '<svg width="320" height="140"><rect width="320" height="140" fill="white"/><text x="25" y="80" font-size="30">ALPHA 42</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  await files.write(repo, "/work/generated-diagram.png", generated);
  const imageAsset = await runtime.media.publish(
    session.id,
    "image-check",
    "/work/generated-diagram.png",
  );
  await runtime.media.translate(imageAsset.id);
  assert.match(store.asset(imageAsset.id)?.descriptionZh || "", /42/);
  console.log("PASS: generated image local OCR and real vision translation");

  const caps = await runtime.capabilities(session.id);
  const review: Review = {
    id: randomUUID(),
    sessionId: session.id,
    original: "Generate a localizable report.",
    english:
      'Read the attached image, which contains a simple English label. Then create /work/folio-report.html: one heading "Image report", one sentence confirming the label, a button "Add item" and a counter incremented by a classic inline script. Use the folio-i18n dictionary contract for visible labels. Publish the HTML with mcp__folio__publish_file. Reply briefly when done. Do not do other work.',
    findings: [],
    status: "prepared",
    createdAt: new Date().toISOString(),
    mode: "direct",
    steering: false,
    attachments: [upload.id],
    attachmentVersions: { [upload.id]: upload.revision },
  };
  const chosen =
    caps.models.find((m) => /haiku/i.test(m.value)) || caps.models[0];
  const run = await runtime.start(review, {
    model: chosen.value,
    permissionMode: "auto",
    effort: "off",
    downstreamMode: "all",
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Live artifact turn timeout")),
      150000,
    );
    const listener = (e: any) => {
      if (e.type === "permission") {
        void runtime.answer(e.data.id, { allow: true }).catch(reject);
      }
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        run.listeners.delete(listener);
        e.type === "done" ? resolve() : reject(Error(e.text));
      }
    };
    run.listeners.add(listener);
  });
  const asset = store
    .assets(session.id)
    .find((a) => a.kind === "html" && a.publishedRuns?.includes(run.id));
  assert.ok(
    asset?.previewReady,
    "Claude did not publish a previewable HTML file",
  );
  await runtime.media.translate(asset.id);
  assert.ok(store.asset(asset.id)?.translatedCatalog);
  const blocks = store.blocks(session.id);
  assert.ok(blocks.some((b) => b.kind === "tool"));
  assert.ok(blocks.some((b) => b.kind === "tool_result"));
  assert.ok(
    store.visibleMessages(session.id).some((m) => m.role === "assistant"),
  );
  console.log(
    JSON.stringify({
      liveModel: chosen.value,
      htmlPublished: true,
      pageTranslated: true,
      traceBlocks: blocks.length,
      visionModel: vision,
    }),
  );
  // O_NOFOLLOW must also reject a model-created symlink to files outside /work.
  const proc = (await import("../server/sandbox.ts")).makeSandboxSpawner(repo)({
    command: "python3",
    args: [
      "-c",
      "import os; p='/work/folio-outside-link';\ntry: os.symlink('/etc/passwd',p)\nexcept FileExistsError: pass",
    ],
    cwd: "/work",
    env: {},
  });
  proc.stdin.end();
  await new Promise((r) => proc.on("exit", r));
  await assert.rejects(files.read(repo, "/work/folio-outside-link"));
  console.log(
    "PASS: generated HTML, native image input, MCP publisher, page translation, trace persistence and symlink rejection",
  );
} finally {
  await runtime.shutdown();
  store.close();
  await sandbox("/sandbox/stop", "POST", { repo });
  assert.equal(
    ((await sandbox("/sandbox/status?repo=" + repo)) as any).running,
    false,
  );
  console.log(
    "PASS: dedicated test sandbox stopped; persistent test volumes retained",
  );
}
