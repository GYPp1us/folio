import { useMemo } from "react";
import { Activity } from "lucide-react";
import { sessionTokens } from "../shared/usage";

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

const time = (value: unknown) => {
  const ms = number(value);
  if (ms === null) return "—";
  return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s";
};

export function PerformanceBar({
  usage,
  onOpen,
}: {
  usage?: Record<string, unknown>;
  onOpen: () => void;
}) {
  const { totals } = useMemo(() => sessionTokens(undefined, usage), [usage]);
  const { input, output, cacheRead, cacheWrite, total } = totals;
  const cachedInput =
    input !== null && cacheRead !== null && cacheWrite !== null
      ? input + cacheRead + cacheWrite
      : 0;
  const hit =
    cachedInput && cacheRead !== null
      ? ((100 * cacheRead) / cachedInput).toFixed(1) + "%"
      : "—";
  const cost = number(usage?.total_cost_usd);
  const latest = usage?.last_result as
    { durationMs?: number; apiMs?: number; tps?: number } | undefined;
  const tps = number(latest?.tps);
  return (
    <footer className="performance-bar" aria-label="会话性能">
      <button
        type="button"
        className="text-button performance-link"
        onClick={onOpen}
        title="打开用量详情"
      >
        <Activity size={13} /> 会话性能
      </button>
      <span title="会话累计，包含输入、输出和缓存读写">
        <b>{total?.toLocaleString() ?? "—"}</b> token
      </span>
      <span className="performance-extra">
        输出 <b>{output?.toLocaleString() ?? "—"}</b>
      </span>
      <span title="最近一轮中主模型完整流式输出的平均速率，按 SDK 实际到达时间计算">
        TPS <b>{tps === null ? "—" : tps.toFixed(1)}</b>
      </span>
      <span title="缓存读取 /（非缓存输入 + 缓存读取 + 缓存写入）">
        缓存命中 <b>{hit}</b>
      </span>
      <span title="最近一次 SDK 结果的耗时">
        最近执行 <b>{time(latest?.durationMs)}</b>
      </span>
      <span
        className="performance-extra"
        title="最近一次 SDK 结果报告的 API 用时"
      >
        API <b>{time(latest?.apiMs)}</b>
      </span>
      <span className="performance-extra" title="SDK 的会话累计估算费用">
        估算 <b>{cost === null ? "—" : "$" + cost.toFixed(4)}</b>
      </span>
    </footer>
  );
}
