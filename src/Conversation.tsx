import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Virtuoso, type VirtuosoHandle, type ListItem } from "react-virtuoso";
import { ArrowDown, ChevronRight } from "lucide-react";
import {
  buildTranscript,
  StreamSegments,
  finalReplyStart,
  type TranscriptRow,
  type TranscriptView,
} from "../shared/transcript";
import type { Asset, Message, TraceBlock } from "../shared/types";
import { ToolDetail, TranslateButton } from "./Process";
import { CopyButton, RichText } from "./ui";
import { AssetRail } from "./Assets";

export type ConversationHandle = { follow: () => void };
type Mode = "tail" | "reading" | "final";
const FooterContext = createContext<{ children: ReactNode; spacer: number }>({
  children: null,
  spacer: 0,
});
function Footer() {
  const { children, spacer } = useContext(FooterContext);
  return (
    <div className="transcript-footer">
      {children}
      <div aria-hidden="true" style={{ height: spacer }} />
    </div>
  );
}
const components = { Footer };
const Row = memo(function Row({
  row,
  view,
  open,
  onToggle,
  onError,
  onOpen,
  onReference,
}: {
  row: TranscriptRow;
  view: TranscriptView;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  onError: (s: string) => void;
  onOpen: (a: Asset) => void;
  onReference: (a: Asset) => void;
}) {
  const { message, block } = row;
  const text = <SegmentText row={row} view={view} />;
  return (
    <div
      data-transcript-key={row.key}
      data-run-id={row.runId}
      data-message-id={message?.id}
      data-block-id={block?.id}
      data-final-start={
        message?.role === "assistant" && row.first ? row.runId : undefined
      }
      className={`transcript-item ${row.kind === "tool" ? "transcript-tool" : row.kind === "dialogue" || row.kind === "stream" ? "transcript-dialogue" : "transcript-message message " + message?.role} ${row.first ? "part-first" : "part-continuation"} ${row.last ? "part-last" : ""}`}
    >
      {row.kind === "tool" && block ? (
        <ToolDetail
          block={block}
          results={row.results}
          view={view}
          onError={onError}
          open={open}
          onOpenChange={(value) => onToggle(block.id, value)}
        />
      ) : (
        <>
          {row.first &&
            (message ? (
              <div className="message-head">
                <strong>
                  {message.role === "user" ? "你" : "Claude Code"}
                </strong>
                {message.kind === "steering" && (
                  <span className="tag">插话</span>
                )}
                <time>
                  {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                {message.sdkUuid && (
                  <button
                    className="text-button checkpoint"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(message.sdkUuid!)
                        .then(() => onError("检查点 UUID 已复制"))
                    }
                  >
                    检查点
                  </button>
                )}
                {message.role === "assistant" && !message.chinese && (
                  <TranslateButton
                    path={
                      message.blockId
                        ? `/blocks/${message.blockId}/translate`
                        : `/messages/${message.id}/translate`
                    }
                    state={block?.translationState}
                    error={block?.translationError}
                    onError={onError}
                  />
                )}
                <CopyButton
                  text={
                    view === "original"
                      ? message.original
                      : message.chinese || message.original
                  }
                />
              </div>
            ) : (
              <div className="process-dialogue-head">
                <span>{block?.parentToolId ? "子代理" : "Claude Code"}</span>
                {block && !block.chinese && (
                  <TranslateButton
                    path={`/blocks/${block.id}/translate`}
                    state={block.translationState}
                    error={block.translationError}
                    onError={onError}
                  />
                )}
              </div>
            ))}
          {row.kind === "stream" && row.first && (
            <span className="language-label">正在接收</span>
          )}
          {text}
          <AssetRail
            assets={row.assets}
            onError={onError}
            onOpen={onOpen}
            onReference={onReference}
          />
        </>
      )}
    </div>
  );
});
const SegmentText = memo(function SegmentText({
  row,
  view,
}: {
  row: TranscriptRow;
  view: TranscriptView;
}) {
  const rich = row.kind !== "stream" && row.message?.role !== "user";
  return row.bilingual ? (
    <div className="bilingual">
      <div>
        {row.first && <span className="language-label">中文</span>}
        <RichText text={row.chinese || ""} rich={rich} locale="zh" />
      </div>
      <div>
        {row.first && <span className="language-label">原文</span>}
        <RichText text={row.original} rich={rich} locale="en" />
      </div>
    </div>
  ) : (
    <RichText
      text={row.original}
      rich={rich}
      locale={view === "original" ? "en" : "zh"}
    />
  );
});

export const Conversation = forwardRef<
  ConversationHandle,
  {
    messages: Message[];
    blocks: TraceBlock[];
    assets: Asset[];
    view: TranscriptView;
    completedRunId: string;
    activeRunId: string;
    liveText: string;
    liveRunId: string;
    children: ReactNode;
    onError: (s: string) => void;
    onOpen: (a: Asset) => void;
    onReference: (a: Asset) => void;
  }
>(function Conversation(
  {
    messages,
    blocks,
    assets,
    view,
    completedRunId,
    activeRunId,
    liveText,
    liveRunId,
    children,
    onError,
    onOpen,
    onReference,
  },
  ref,
) {
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(
    () => new Set(),
  );
  const history = useMemo(
    () =>
      buildTranscript(messages, blocks, assets, view, {
        activeRunId,
        expanded: expandedRuns,
      }),
    [messages, blocks, assets, view, activeRunId, expandedRuns],
  );
  const stream = useRef(new StreamSegments());
  const rows = useMemo(() => {
    const parts = stream.current.update(liveRunId ? liveText : "", liveRunId);
    if (!parts.length) return history;
    return history.concat(
      parts.map((original, index): TranscriptRow => ({
        key: `stream:${liveRunId}:${index}`,
        kind: "stream",
        runId: liveRunId,
        original,
        bilingual: false,
        first: index === 0,
        last: index === parts.length - 1,
        results: [],
        assets: [],
      })),
    );
  }, [history, liveText, liveRunId]);
  const list = useRef<VirtuosoHandle>(null),
    scroller = useRef<HTMLElement | null>(null),
    wrapper = useRef<HTMLDivElement>(null);
  const mode = useRef<Mode>("tail"),
    [reading, setReading] = useState(false),
    [opened, setOpened] = useState<Set<string>>(() => new Set());
  const anchor = useRef<{ messageId: string; key: string } | null>(null),
    handled = useRef(""),
    frame = useRef(0),
    pendingSummary = useRef<{ runId: string; focus: boolean } | null>(null),
    touchStart = useRef<{ x: number; y: number } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [viewport, setViewport] = useState(0),
    [spacer, setSpacer] = useState(0);
  const sizes = useRef(new Map<string, number>()),
    gesture = useRef(0),
    previousTop = useRef(0);
  const changeMode = useCallback((value: Mode) => {
    mode.current = value;
    setReading(value === "reading");
  }, []);
  const align = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = scroller.current;
      if (!element) return;
      const summary = pendingSummary.current;
      if (summary) {
        pendingSummary.current = null;
        const index = rowsRef.current.findIndex(
          (row) => row.key === "run-summary:" + summary.runId,
        );
        if (index >= 0)
          list.current?.scrollToIndex({
            index,
            align: "start",
            behavior: "auto",
          });
        if (summary.focus)
          requestAnimationFrame(() => {
            document
              .getElementById("run-details-" + summary.runId)
              ?.focus({ preventScroll: true });
          });
      } else if (mode.current === "tail") {
        if (element.scrollHeight - element.clientHeight - element.scrollTop > 1)
          list.current?.scrollTo({
            top: Number.MAX_SAFE_INTEGER,
            behavior: "auto",
          });
      } else if (mode.current === "final" && anchor.current) {
        const key = anchor.current.key;
        const index = rowsRef.current.findIndex((row) => row.key === key);
        const item = element.querySelector<HTMLElement>(
          '[data-transcript-key="' + CSS.escape(key) + '"]',
        );
        if (item) {
          const offset =
            item.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
          if (Math.abs(offset) > 1) element.scrollTop += offset;
        } else if (index >= 0)
          list.current?.scrollToIndex({
            index,
            align: "start",
            behavior: "auto",
          });
      }
    });
  }, []);
  const follow = useCallback(() => {
    anchor.current = null;
    sizes.current.clear();
    setSpacer(0);
    changeMode("tail");
    align();
  }, [align, changeMode]);
  useImperativeHandle(ref, () => ({ follow }), [follow]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport(element.clientHeight),
    );
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!completedRunId || handled.current === completedRunId) return;
    const index = finalReplyStart(rows, completedRunId);
    if (index < 0) return;
    handled.current = completedRunId;
    if (mode.current !== "tail") return;
    const prior = rows[index - 1];
    anchor.current = {
      key:
        prior?.kind === "run-summary" && prior.runId === completedRunId
          ? prior.key
          : rows[index].key,
      messageId: rows[index].message!.id,
    };
    sizes.current.clear();
    setSpacer(Math.max(0, viewport - 60));
    changeMode("final");
    align();
  }, [completedRunId, rows, viewport, align, changeMode]);
  useLayoutEffect(() => {
    if (pendingSummary.current || mode.current !== "reading") align();
  }, [rows, view, viewport, align]);
  const onSizes = useCallback(
    (items: ListItem<TranscriptRow>[]) => {
      if (mode.current !== "final" || !anchor.current) return;
      for (const item of items)
        if (
          item.data &&
          (item.data.message?.id === anchor.current.messageId ||
            item.data.key === anchor.current.key)
        )
          sizes.current.set(item.data.key, item.size);
      const height = [...sizes.current.values()].reduce((a, b) => a + b, 0);
      setSpacer(Math.max(0, viewport - height - 20));
    },
    [viewport],
  );
  const toggle = useCallback(
    (id: string, open: boolean) =>
      setOpened((previous) => {
        if (previous.has(id) === open) return previous;
        const next = new Set(previous);
        open ? next.add(id) : next.delete(id);
        return next;
      }),
    [],
  );
  const toggleRun = (runId: string, focus: boolean) => {
    anchor.current = null;
    sizes.current.clear();
    setSpacer(0);
    pendingSummary.current = { runId, focus };
    changeMode("reading");
    setExpandedRuns((previous) => {
      const next = new Set(previous);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };
  const pause = () => {
    gesture.current = Date.now();
    changeMode("reading");
  };
  const footer = useMemo(() => ({ children, spacer }), [children, spacer]);
  return (
    <div
      className="conversation-window"
      ref={wrapper}
      onWheelCapture={(e) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        const element = scroller.current;
        if (
          e.deltaY > 0 &&
          element &&
          element.scrollHeight - element.clientHeight - element.scrollTop < 50
        )
          follow();
        else pause();
      }}
      onTouchStartCapture={(event) => {
        const touch = event.touches[0];
        touchStart.current =
          event.touches.length === 1
            ? { x: touch.clientX, y: touch.clientY }
            : null;
      }}
      onTouchMoveCapture={(event) => {
        const start = touchStart.current;
        if (!start || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const vertical = Math.abs(touch.clientY - start.y);
        if (vertical > 8 && vertical > Math.abs(touch.clientX - start.x))
          pause();
      }}
      onPointerDownCapture={(e) => {
        if (e.target === scroller.current) pause();
      }}
      onKeyDownCapture={(e) => {
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(e.key) &&
          !(
            e.target instanceof Element &&
            e.target.closest(
              "button, a, input, textarea, select, summary, [contenteditable], [role=button]",
            )
          )
        )
          pause();
      }}
    >
      <FooterContext.Provider value={footer}>
        <Virtuoso
          className="conversation"
          ref={list}
          data={rows}
          components={components}
          computeItemKey={(_index, row) => row.key}
          initialTopMostItemIndex={
            rows.length ? { index: rows.length - 1, align: "end" } : undefined
          }
          defaultItemHeight={100}
          increaseViewportBy={{ top: 300, bottom: 300 }}
          scrollerRef={(element) => {
            scroller.current = element instanceof HTMLElement ? element : null;
          }}
          totalListHeightChanged={() => align()}
          itemsRendered={onSizes}
          atBottomThreshold={50}
          atBottomStateChange={(bottom) => {
            if (
              bottom &&
              mode.current === "reading" &&
              Date.now() - gesture.current < 1200
            )
              follow();
          }}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            if (
              top < previousTop.current - 2 &&
              Date.now() - gesture.current < 1200
            )
              changeMode("reading");
            if (
              top > previousTop.current &&
              Date.now() - gesture.current < 1200 &&
              e.currentTarget.scrollHeight -
                e.currentTarget.clientHeight -
                top <
                50
            )
              follow();
            previousTop.current = top;
          }}
          itemContent={(_index, row) =>
            row.kind === "run-summary" && row.runId ? (
              <div
                className="transcript-item run-summary"
                data-transcript-key={row.key}
              >
                <button
                  type="button"
                  id={"run-details-" + row.runId}
                  aria-expanded={expandedRuns.has(row.runId)}
                  onClick={(event) => toggleRun(row.runId!, event.detail === 0)}
                >
                  <ChevronRight size={13} />
                  <span>
                    {expandedRuns.has(row.runId)
                      ? "收起执行过程"
                      : "展开执行过程"}
                  </span>
                  <small>{row.detailCount} 条</small>
                </button>
              </div>
            ) : (
              <Row
                row={row}
                view={view}
                open={!!row.block && opened.has(row.block.id)}
                onToggle={toggle}
                onError={onError}
                onOpen={onOpen}
                onReference={onReference}
              />
            )
          }
        />
      </FooterContext.Provider>
      {reading && (
        <button className="jump-latest" onClick={follow}>
          <ArrowDown size={13} />
          回到最新
        </button>
      )}
    </div>
  );
});
