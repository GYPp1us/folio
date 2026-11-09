import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { config } from "../server/config.ts";
import { MediaService, previewHtml } from "../server/media.ts";
import { SandboxFiles } from "../server/files.ts";
import { sandbox } from "../server/sandbox.ts";
import { sessionTokens } from "../shared/usage.ts";
import { translate } from "../server/translator.ts";
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw Error("FOLIO_VERIFY_DIR required");
// Read encrypted session counters without opening a second mutating production Store.
const db = new DatabaseSync(join(config.dataDir, "workspace.sqlite"), {
  readOnly: true,
});
const decoder = Object.create(Store.prototype) as Store;
decoder.key = readFileSync(join(config.dataDir, "vault.key"));
const sessions = (
  db.prepare("SELECT data FROM sessions ORDER BY created DESC").all() as {
    data: string;
  }[]
).map((r) => decoder.open<any>(r.data));
db.close();
const recorded = sessions.find(
  (s) => s.usage && sessionTokens({}, s.usage).totals.total !== null,
);
assert.ok(recorded, "No persisted real model counters");
const totals = sessionTokens({}, recorded.usage).totals;
assert.equal(
  totals.total,
  totals.input! + totals.output! + totals.cacheRead! + totals.cacheWrite!,
);
assert.equal(
  sessionTokens(recorded.usage, recorded.usage).totals.total,
  totals.total,
);
console.log(
  JSON.stringify({
    persistedSessionCountersVerified: true,
    categories: ["input", "output", "cacheRead", "cacheWrite"],
    noDuplicateSnapshots: true,
  }),
);
const repo = "folio-render-check",
  store = new Store(directory),
  media = new MediaService(store),
  session = store.create(repo);
const svg =
  '<svg width="320" height="130"><rect width="320" height="130" fill="white"/><text x="24" y="76" font-size="30">ALPHA 42</text></svg>';
try {
  await sandbox("/sandbox/start", "POST", { repo });
  const diagram = await media.inline(session.id, "svg", svg);
  assert.ok(
    store
      .assetBytes(diagram.id)
      .toString()
      .includes('xmlns="http://www.w3.org/2000/svg"'),
  );
  await media.translate(diagram.id);
  assert.match(store.asset(diagram.id)?.descriptionZh || "", /42/);
  const html = await media.inline(
    session.id,
    "html",
    "<section><h2>Usage summary</h2><button onclick=\"this.textContent='Clicked'\">Add item</button></section>",
  );
  await media.translate(html.id);
  const translated = store.asset(html.id)!;
  assert.ok(
    translated.translatedCatalog &&
      Object.values(translated.translatedCatalog).some((v) =>
        /\p{Script=Han}/u.test(v),
      ),
  );
  const frame = previewHtml(
    store.derivative(html.id).toString(),
    html.catalog!,
    translated.translatedCatalog,
    "zh",
    {},
  );
  assert.ok(frame.includes("folio-preview-size"));
  const original =
    'Here is the preview: <div style="color:#b96d4c">Hello</div>';
  const zh = await translate(original, "zh");
  assert.ok(zh.includes('<div style="color:#b96d4c">Hello</div>'));
  const bridge = new SandboxFiles();
  await bridge.write(repo, "/work/inline-render.svg", Buffer.from(svg));
  await sandbox("/sandbox/stop", "POST", { repo });
  const fromFile = await media.inline(
    session.id,
    "image",
    "/work/inline-render.svg",
  );
  assert.equal(fromFile.kind, "image");
  console.log(
    JSON.stringify({
      inlineSvgVision: true,
      inlineHtmlLocalization: true,
      markupPreserved: true,
      workspaceImageBridge: true,
      defaultMode: session.downstreamMode,
    }),
  );
} finally {
  await media.shutdown();
  store.close();
  await sandbox("/sandbox/stop", "POST", { repo });
  assert.equal(
    ((await sandbox("/sandbox/status?repo=" + repo)) as any).running,
    false,
  );
  console.log("PASS: dedicated render sandbox stopped; test volumes retained");
}
