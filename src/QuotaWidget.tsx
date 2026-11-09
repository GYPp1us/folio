import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, Busy } from "./ui";
import type { SandboxUsage } from "../shared/usage";
import type { QuotaSnapshot } from "../shared/types";

export function QuotaWidget({
  sessionId,
  repo,
  usage,
  onOpen,
}: {
  sessionId?: string;
  repo?: string;
  usage?: Record<string, unknown>;
  onOpen: () => void;
}) {
  const [value, setValue] = useState<QuotaSnapshot>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(undefined);
    setError("");
    if (!sessionId) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!document.hidden) {
        setBusy(true);
        try {
          const data = await api<QuotaSnapshot>(`/sessions/${sessionId}/quota`);
          if (!disposed) {
            setValue(data);
            setError("");
          }
        } catch (e) {
          if (!disposed) setError((e as Error).message);
        } finally {
          if (!disposed) setBusy(false);
        }
      }
      if (!disposed) timer = setTimeout(load, 60000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId]);
  const [summary, setSummary] = useState<SandboxUsage>(),
    [summaryError, setSummaryError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!repo) return;
    const load = async () => {
      try {
        const data = await api<SandboxUsage>(
          `/sandbox/usage?repo=${encodeURIComponent(repo)}`,
        );
        if (!disposed) {
          setSummary(data);
          setSummaryError(false);
        }
      } catch {
        if (!disposed) setSummaryError(true);
      } finally {
        if (!disposed) timer = setTimeout(load, 30000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [repo, usage]);
  const current = summary?.repo === repo ? summary : undefined;
  const tokenText = (
    key: "total" | "input" | "output" | "cacheRead" | "cacheWrite",
  ) => {
    if (!current) return "—";
    const value = current.totals[key];
    return value === null
      ? current.knownTotals[key] > 0
        ? "≥ " + current.knownTotals[key].toLocaleString()
        : "—"
      : value.toLocaleString();
  };
  const rows = [
    { label: "5h", row: value?.rows.find((r) => r.kind === "session") },
    { label: "本周", row: value?.rows.find((r) => r.kind === "weekly_all") },
  ];
  return (
    <div className="quota-widget">
      <button
        className="sandbox-token-summary"
        onClick={onOpen}
        title="汇总 Folio 中当前沙箱所有会话的已保存用量，包含输入、输出与缓存；不重复相加累计快照。"
      >
        <span>
          沙箱累计 token{" "}
          <small>{current ? `${current.sessionCount} 个会话` : ""}</small>
        </span>
        <strong>{tokenText("total")}</strong>
        <small>
          输入 {tokenText("input")} · 输出 {tokenText("output")}
        </small>
        <small>
          缓存读 {tokenText("cacheRead")} · 写 {tokenText("cacheWrite")}
        </small>
        {summaryError && (
          <small>
            {current ? "上次统计 · 暂时无法刷新" : "沙箱统计暂不可用"}
          </small>
        )}
        {!!current?.pendingSessions && (
          <small>{current.pendingSessions} 个会话尚未同步完整用量</small>
        )}
      </button>
      <div className="quota-heading">
        <button onClick={onOpen}>账号额度</button>
        {busy ? <Busy /> : <RotateCcw size={11} aria-hidden />}
      </div>
      {rows.map(({ label, row }) => (
        <button
          className="quota-row"
          key={label}
          onClick={onOpen}
          title={
            row?.resetsAt
              ? `下次重置：${new Date(row.resetsAt).toLocaleString()}`
              : value?.reason || error || "等待用量数据"
          }
        >
          <span>{label}</span>
          <span className="quota-track">
            <i
              style={{
                width: `${Math.max(0, Math.min(100, row?.percent ?? 0))}%`,
              }}
            />
          </span>
          <span>
            {row?.percent == null ? "—" : `${Math.round(row.percent)}%`}
          </span>
          <small>
            {row?.resetsAt
              ? `${new Date(row.resetsAt).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 重置`
              : "暂无重置时间"}
          </small>
        </button>
      ))}
      {(value?.stale || value?.reason || error) && (
        <button
          className="quota-note"
          onClick={onOpen}
          title={value?.reason || error}
        >
          {value?.stale
            ? "上次数据 · 暂时无法刷新"
            : value?.authMode === "token"
              ? "沙箱登录后查看额度"
              : error
                ? "用量暂不可用"
                : value?.reason}
        </button>
      )}
    </div>
  );
}
