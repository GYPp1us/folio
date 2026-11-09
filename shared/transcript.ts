import { richParts } from "./rich";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Asset, Message, TraceBlock } from "./types";
import { isToolDetail } from "./tool-progress";
export type TranscriptView = "zh" | "both" | "original";
type Segment = { original: string; chinese?: string; bilingual: boolean };
export type TranscriptRow = Segment & {
  key: string;
  kind: "message" | "dialogue" | "tool" | "stream";
  runId?: string;
  message?: Message;
  block?: TraceBlock;
  results: TraceBlock[];
  assets: Asset[];
  first: boolean;
  last: boolean;
};

// Split at Markdown block boundaries, preserving fences, tables, HTML and links.
// An indivisible block is kept intact; history length never dictates DOM size.
export function markdownSegments(
  text: string,
  size = 3500,
  references = true,
): string[] {
  if (text.length <= size) return [text];
  const protectedRanges = richParts(text);
  const nodes = fromMarkdown(text).children;
  const definitions = nodes.filter(
    (n) => n.type === "definition" || n.type === "footnoteDefinition",
  );
  const referenceText = definitions
    .map((n) => text.slice(n.position!.start.offset, n.position!.end.offset))
    .join("\n");
  const parts: string[] = [];
  let start = 0,
    end = 0;
  for (const node of nodes) {
    const next = node.position?.end.offset || end;
    if (
      end > start &&
      next - start > size &&
      !protectedRanges.some((part) => end > part.start && end < part.end)
    ) {
      parts.push(text.slice(start, end));
      start = end;
    }
    end = next;
  }
  parts.push(text.slice(start));
  return references && referenceText
    ? parts.map((p) => p + "\n\n" + referenceText)
    : parts;
}
const cache = new WeakMap<object, Map<TranscriptView, Segment[]>>();
function segments(value: Message | TraceBlock, view: TranscriptView) {
  let entry = cache.get(value);
  if (!entry) cache.set(value, (entry = new Map()));
  const known = entry.get(view);
  if (known) return known;
  const bilingual =
    view === "both" && !!value.chinese && value.chinese !== value.original;
  const original = markdownSegments(
    view === "zh" && value.chinese ? value.chinese : value.original,
  );
  const chinese = bilingual ? markdownSegments(value.chinese!) : [];
  const result = Array.from(
    { length: Math.max(original.length, chinese.length) },
    (_, i) => ({
      original: original[i] || "",
      chinese: chinese[i],
      bilingual,
    }),
  );
  entry.set(view, result);
  return result;
}

export function buildTranscript(
  messages: Message[],
  blocks: TraceBlock[],
  assets: Asset[],
  view: TranscriptView,
): TranscriptRow[] {
  const byBlock = new Map(blocks.map((b) => [b.id, b]));
  const byAsset = new Map(assets.map((a) => [a.id, a]));
  const outputs = new Map<string, Asset[]>(),
    lastAssistant = new Map<string, string>();
  for (const a of assets)
    for (const run of a.publishedRuns || []) {
      const list = outputs.get(run) || [];
      list.push(a);
      outputs.set(run, list);
    }
  for (const m of messages)
    if (m.role === "assistant" && m.runId) lastAssistant.set(m.runId, m.id);
  const calls = new Set(
    blocks
      .filter((b) => b.kind === "tool")
      .map((b) => b.runId + ":" + b.toolId),
  );
  const results = new Map<string, TraceBlock[]>();
  for (const block of blocks)
    if (
      isToolDetail(block) &&
      block.toolId &&
      calls.has(block.runId + ":" + block.toolId)
    ) {
      const list = results.get(block.runId + ":" + block.toolId) || [];
      list.push(block);
      results.set(block.runId + ":" + block.toolId, list);
    }
  const traces = blocks.filter(
    (b) =>
      b.kind !== "final" &&
      !(isToolDetail(b) && b.toolId && calls.has(b.runId + ":" + b.toolId)),
  );
  const rows: TranscriptRow[] = [];
  let mi = 0,
    bi = 0;
  while (mi < messages.length || bi < traces.length) {
    const message = messages[mi],
      block = traces[bi];
    const mt = message ? Date.parse(message.createdAt) : Infinity,
      bt = block ? Date.parse(block.createdAt) : Infinity;
    if (
      message &&
      (mt < bt || (mt === bt && message.role !== "assistant") || !block)
    ) {
      mi++;
      const parts = segments(message, view);
      const attached = (message.attachments || [])
        .map((id) => byAsset.get(id))
        .filter((a): a is Asset => !!a);
      const published =
        message.runId && lastAssistant.get(message.runId) === message.id
          ? outputs.get(message.runId) || []
          : [];
      const rail = [
        ...new Map([...attached, ...published].map((a) => [a.id, a])).values(),
      ];
      parts.forEach((part, index) =>
        rows.push({
          ...part,
          key: `message:${message.id}:${index}`,
          kind: "message",
          message,
          block: message.blockId ? byBlock.get(message.blockId) : undefined,
          runId: message.runId,
          first: index === 0,
          last: index === parts.length - 1,
          results: [],
          assets: index === parts.length - 1 ? rail : [],
        }),
      );
    } else if (block) {
      bi++;
      const parts =
        block.kind === "commentary"
          ? segments(block, view)
          : [{ original: "", bilingual: false }];
      parts.forEach((part, index) =>
        rows.push({
          ...part,
          key: `block:${block.id}:${index}`,
          kind: block.kind === "commentary" ? "dialogue" : "tool",
          block,
          runId: block.runId,
          first: index === 0,
          last: index === parts.length - 1,
          results: results.get(block.runId + ":" + block.toolId) || [],
          assets: [],
        }),
      );
    }
  }
  return rows;
}

export function finalReplyStart(rows: TranscriptRow[], runId: string) {
  // A run can include multiple queued/steering replies. Focus its last reply.
  for (let i = rows.length - 1; i >= 0; i--)
    if (
      rows[i].kind === "message" &&
      rows[i].first &&
      rows[i].message?.role === "assistant" &&
      rows[i].runId === runId
    )
      return i;
  return -1;
}

// Freeze complete streaming chunks. Only the unsealed tail is reparsed;
// a new assistant message/reset cannot inherit chunks from its predecessor.
export class StreamSegments {
  private runId = "";
  private previous = "";
  private offset = 0;
  private sealed: string[] = [];
  update(text: string, runId: string) {
    if (this.runId !== runId || !text.startsWith(this.previous)) {
      this.runId = runId;
      this.offset = 0;
      this.sealed = [];
    }
    this.previous = text;
    if (!text) {
      this.offset = 0;
      this.sealed = [];
      return [];
    }
    const tail = text.slice(this.offset);
    const pieces =
      tail.length > 5000 ? markdownSegments(tail, 3500, false) : [tail];
    for (const piece of pieces.slice(0, -1)) {
      this.sealed.push(piece);
      this.offset += piece.length;
    }
    return [...this.sealed, pieces.at(-1)!];
  }
}
