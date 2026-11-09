import { useState } from "react";
import { Languages, ChevronRight, Wrench } from "lucide-react";
import { api, Busy, JsonView, RichText } from "./ui";
import type { TraceBlock, TranslationState } from "../shared/types";
import { isToolDetail } from "../shared/tool-progress";
export type TextView = "zh" | "both" | "original";

export function TranslateButton({
  path,
  state,
  error,
  onError,
}: {
  path: string;
  state?: TranslationState;
  error?: string;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="block-translate"
      title={error || "翻译为中文"}
      aria-label={error ? "重试翻译" : "翻译为中文"}
      disabled={busy || state === "pending"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        void api(path, {})
          .catch((e) => onError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      {busy || state === "pending" ? <Busy /> : <Languages size={12} />}
      {error ? "重试" : "翻译"}
    </button>
  );
}
export function BlockText({
  original,
  chinese,
  view,
  rich = true,
}: {
  original: string;
  chinese?: string;
  view: TextView;
  rich?: boolean;
}) {
  return view === "both" && chinese && chinese !== original ? (
    <div className="bilingual">
      <div>
        <span className="language-label">中文</span>
        <RichText text={chinese} rich={rich} locale="zh" />
      </div>
      <div>
        <span className="language-label">原文</span>
        <RichText text={original} rich={rich} locale="en" />
      </div>
    </div>
  ) : (
    <RichText
      text={view === "original" || !chinese ? original : chinese}
      rich={rich}
      locale={view === "original" ? "en" : "zh"}
    />
  );
}
function Translation({
  block,
  onError,
}: {
  block: TraceBlock;
  onError: (text: string) => void;
}) {
  return !block.chinese ? (
    <TranslateButton
      path={`/blocks/${block.id}/translate`}
      state={block.translationState}
      error={block.translationError}
      onError={onError}
    />
  ) : null;
}
function DetailText({ block, view }: { block: TraceBlock; view: TextView }) {
  return (block.data as any)?.format === "code" ||
    (block.kind === "tool_result" && (block.data as any)?.isError) ? (
    <pre className="tool-command">
      <code>{block.original}</code>
    </pre>
  ) : (
    <BlockText original={block.original} chinese={block.chinese} view={view} />
  );
}
export function ToolDetail({
  block,
  results,
  view,
  onError,
  open,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  block: TraceBlock;
  results: TraceBlock[];
  view: TextView;
  onError: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`process-row ${block.parentToolId ? "subagent" : ""}`}>
      <details
        open={open ?? expanded}
        onToggle={(e) => {
          setExpanded(e.currentTarget.open);
          onOpenChange?.(e.currentTarget.open);
        }}
      >
        <summary>
          <ChevronRight className="process-chevron" size={11} />
          <Wrench size={12} />
          <span>{block.title}</span>
          <small>
            {block.kind === "thinking"
              ? "思考"
              : block.kind === "tool_description"
                ? "说明"
                : block.kind === "tool_result"
                  ? "结果"
                  : block.kind === "tool_progress"
                    ? "进度"
                    : results.some(
                          (result) =>
                            result.kind === "tool_result" &&
                            (result.data as any)?.isError,
                        )
                      ? "失败"
                      : results.some((result) => result.kind === "tool_result")
                        ? "已返回"
                        : results.length
                          ? "运行中"
                          : "调用"}
          </small>
        </summary>
        {(open ?? expanded) && (
          <div className="process-detail">
            <DetailText block={block} view={view} />
            {block.data != null && (
              <details className="raw-details">
                <summary>原始详情</summary>
                <JsonView value={block.data} />
              </details>
            )}
            {results.map((result) => (
              <div className="process-result" key={result.id}>
                <div className="process-result-head">
                  <span>{result.title}</span>
                  <Translation block={result} onError={onError} />
                </div>
                <DetailText block={result} view={view} />
                {result.data != null && (
                  <details className="raw-details">
                    <summary>原始详情</summary>
                    <JsonView value={result.data} />
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
      <Translation block={block} onError={onError} />
    </div>
  );
}
export function ProcessGroup({
  blocks,
  view,
  onError,
  live,
}: {
  blocks: TraceBlock[];
  view: TextView;
  onError: (text: string) => void;
  live?: string;
}) {
  const entries = blocks.filter((b) => b.kind !== "final");
  if (!entries.length && !live) return null;
  const calls = new Set(
    entries
      .filter((b) => b.kind === "tool")
      .map((b) => b.runId + ":" + b.toolId)
      .filter(Boolean),
  );
  const results = new Map<string, TraceBlock[]>();
  for (const block of entries)
    if (
      isToolDetail(block) &&
      block.toolId &&
      calls.has(block.runId + ":" + block.toolId)
    )
      results.set(block.runId + ":" + block.toolId, [
        ...(results.get(block.runId + ":" + block.toolId) || []),
        block,
      ]);
  const groups: { dialogue: boolean; blocks: TraceBlock[] }[] = [];
  for (const block of entries) {
    if (
      isToolDetail(block) &&
      block.toolId &&
      calls.has(block.runId + ":" + block.toolId)
    )
      continue;
    const dialogue = block.kind === "commentary";
    if (!dialogue && groups.at(-1)?.dialogue === false)
      groups.at(-1)!.blocks.push(block);
    else groups.push({ dialogue, blocks: [block] });
  }
  return (
    <div className="process-group">
      {groups.map((group) =>
        group.dialogue ? (
          group.blocks.map((block) => (
            <section
              className={`process-dialogue ${block.parentToolId ? "subagent" : ""}`}
              key={block.id}
            >
              <div className="process-dialogue-head">
                <span>{block.parentToolId ? "子代理" : "Claude Code"}</span>
                <Translation block={block} onError={onError} />
              </div>
              <BlockText
                original={block.original}
                chinese={block.chinese}
                view={view}
              />
            </section>
          ))
        ) : (
          <div className="process-tools" key={group.blocks[0].id}>
            {group.blocks.map((block) => (
              <ToolDetail
                key={block.id}
                block={block}
                results={
                  block.toolId && block.kind === "tool"
                    ? results.get(block.runId + ":" + block.toolId) || []
                    : []
                }
                view={view}
                onError={onError}
              />
            ))}
          </div>
        ),
      )}
      {live && (
        <section className="process-dialogue process-stream">
          <span className="language-label">正在接收</span>
          <RichText text={live} rich={false} />
        </section>
      )}
    </div>
  );
}
