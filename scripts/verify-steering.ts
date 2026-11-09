import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.ts";
import { RuntimeManager } from "../server/runtime.ts";
import { SandboxFiles } from "../server/files.ts";
import { sandbox } from "../server/sandbox.ts";
import type { Review } from "../shared/types.ts";
const directory = process.env.FOLIO_VERIFY_DIR;
if (!directory) throw Error("FOLIO_VERIFY_DIR required");
const store = new Store(directory),
  manager = new RuntimeManager(store),
  bridge = new SandboxFiles();
const repo = "folio-steering-check",
  session = store.create(repo);
session.downstreamMode = "manual";
store.save(session);
const suffix = randomUUID(),
  started = `/work/steer-${suffix}.started`,
  finished = `/work/steer-${suffix}.finished`;
const review = (text: string, steering = false): Review => ({
  id: randomUUID(),
  sessionId: session.id,
  original: text,
  english: text,
  findings: [],
  mode: "direct",
  steering,
  status: "prepared",
  createdAt: new Date().toISOString(),
});
let timeout: ReturnType<typeof setTimeout>;
try {
  const caps = await manager.capabilities(session.id);
  const options = {
    model: caps.models.find((m) => m.value === "haiku")?.value || "haiku",
    permissionMode: "auto" as const,
    effort: "off" as const,
    downstreamMode: "manual" as const,
  };
  const run = await manager.start(
    review(
      `Use Bash exactly once to run this command: printf STARTED > ${started}; sleep 8; printf FINISHED > ${finished}. Keep the command running until completion. After it finishes, reply exactly BASE_FINISHED.`,
    ),
    options,
  );
  const handle = (event: any) => {
    if (event.type === "permission" || event.type === "dialog")
      void manager.answer(event.data.id, { allow: true });
  };
  for (const event of run.events) handle(event);
  run.listeners.add(handle);
  const complete = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(
      () => reject(Error("Queue verification timed out")),
      120000,
    );
    run.listeners.add((event) => {
      if (event.type === "done") resolve();
      else if (event.type === "error") reject(Error(event.text));
    });
  });
  void complete.catch(() => {});
  let toolStarted = false;
  for (let i = 0; i < 250 && !run.done; i++) {
    try {
      if ((await bridge.read(repo, started)).toString() === "STARTED") {
        toolStarted = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(
    toolStarted,
    "Bash command should be actively sleeping before the addition",
  );
  assert.equal(run.done, false);
  const steered = await manager.start(
    review(
      `Keep the currently running Bash command intact. After it finishes, use Read to verify ${finished}, then reply exactly STEER_FINISHED. Do not launch another Bash command.`,
      true,
    ),
    options,
  );
  assert.equal(steered.id, run.id);
  console.log(
    "PASS: addition queued while the original Bash command was active",
  );
  await complete;
  clearTimeout(timeout!);
  assert.equal((await bridge.read(repo, finished)).toString(), "FINISHED");
  const calls = store
    .blocks(session.id)
    .filter((b) => b.kind === "tool" && b.title === "Bash");
  assert.equal(calls.length, 1);
  const result = store
    .blocks(session.id)
    .find((b) => b.kind === "tool_result" && b.toolId === calls[0].toolId);
  assert.ok(result);
  assert.equal((result.data as any).isError, false);
  assert.ok(
    store
      .messages(session.id)
      .some(
        (m) => m.role === "assistant" && m.original.includes("STEER_FINISHED"),
      ),
  );
  assert.equal(
    store.messages(session.id).filter((m) => m.kind === "steering").length,
    1,
  );
  assert.equal(run.pendingSteering?.size, 0);
  assert.equal(run.events.filter((e) => e.type === "done").length, 1);
  console.log(
    JSON.stringify({
      originalToolCompleted: true,
      bashInvocations: calls.length,
      steeringDeliveredOnce: true,
      queueAcknowledged: true,
      runIdPreserved: true,
    }),
  );
} finally {
  clearTimeout(timeout!);
  await manager.shutdown();
  store.close();
  await sandbox("/sandbox/stop", "POST", { repo });
  assert.equal(
    ((await sandbox("/sandbox/status?repo=" + repo)) as any).running,
    false,
  );
  console.log("PASS: steering verification sandbox stopped; volumes retained");
}
