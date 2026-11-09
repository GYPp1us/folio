import { Store } from "./store.ts";
import { detect, maskOutput, restore } from "./privacy.ts";
import { recentDialogue, translate } from "./translator.ts";
import type { TraceBlock, DownstreamMode } from "../shared/types.ts";
export function autoTranslate(kind: TraceBlock["kind"], mode: DownstreamMode) {
  return (
    mode === "all" ||
    (mode === "messages" && ["final", "commentary"].includes(kind))
  );
}
export class BlockTranslations {
  private jobs = new Map<string, Promise<TraceBlock>>();
  private queue: (() => void)[] = [];
  private active = 0;
  private controller = new AbortController();
  constructor(private store: Store) {}
  schedule(block: TraceBlock) {
    if (
      autoTranslate(
        block.kind,
        this.store.session(block.sessionId)?.downstreamMode || "messages",
      )
    )
      void this.translate(block.id).catch(() => {});
  }
  translate(id: string): Promise<TraceBlock> {
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const block = this.store.block(id);
    if (!block) throw new Error("内容块不存在");
    if (block.translationState === "done") return Promise.resolve(block);
    this.store.activities.set(
      block.sessionId,
      "translate:" + id,
      "translation_queued",
      {
        scope: "downstream",
        detail: block.kind === "final" ? "回复" : "过程内容",
        runId: block.runId,
      },
    );
    block.translationState = "pending";
    block.translationError = undefined;
    this.store.saveBlock(block);
    const result = new Promise<TraceBlock>((resolve, reject) => {
      this.queue.push(
        () =>
          void this.perform(id)
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.drain();
            }),
      );
      this.drain();
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, result);
    return result;
  }
  private drain() {
    while (this.active < 2 && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
  private async perform(id: string) {
    let block = this.store.block(id)!;
    this.store.activities.set(
      block.sessionId,
      "translate:" + id,
      "translating",
      {
        scope: "downstream",
        detail: block.kind === "final" ? "回复" : "过程内容",
        runId: block.runId,
      },
    );
    try {
      if ((block.data as { format?: string } | undefined)?.format === "code") {
        block.chinese = block.original;
        block.translationState = "done";
        this.store.saveBlock(block);
        return block;
      }
      const bindings = this.store.bindings(block.sessionId),
        found = detect(block.original).filter(
          (f) => !bindings.some((b) => b.value === f.value),
        );
      if (found.length) {
        this.store.bind(block.sessionId, found);
        bindings.push(...found);
      }
      const context = recentDialogue(
        this.store
          .visibleMessages(block.sessionId)
          .filter((m) => m.createdAt < block.createdAt),
        bindings,
      );
      const value = await translate(
        maskOutput(block.original, bindings),
        "zh",
        this.controller.signal,
        context,
      );
      block = this.store.block(id)!;
      block.chinese = restore(value, bindings);
      block.translationState = "done";
      this.store.saveBlock(block);
      if (block.messageId)
        this.store.updateMessage(block.sessionId, block.messageId, {
          chinese: block.chinese,
        });
      return block;
    } catch (error) {
      block = this.store.block(id)!;
      block.translationState = "error";
      block.translationError = (error as Error).message;
      this.store.saveBlock(block);
      throw error;
    } finally {
      this.store.activities.clear(block.sessionId, "translate:" + id);
    }
  }
  async shutdown() {
    this.controller.abort();
    await Promise.allSettled([...this.jobs.values()]);
    this.controller = new AbortController();
  }
}
