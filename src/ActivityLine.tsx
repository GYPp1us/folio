import { useEffect, useMemo, useState } from "react";
import { CircleHelp } from "lucide-react";
import { Busy } from "./ui";
import {
  activityLabel,
  activitySummary,
  type Activity,
} from "../shared/activity";
export function ActivityLine({
  activities,
  fallback,
  active = false,
  connection = "open",
}: {
  activities: Activity[];
  fallback: string;
  active?: boolean;
  connection?: "connecting" | "open" | "reconnecting" | "closed";
}) {
  const { primary, secondary } = activitySummary(activities),
    [now, setNow] = useState(Date.now());
  const fallbackSince = useMemo(() => Date.now(), [fallback, active]);
  const ticking = !!primary || active;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const disconnected = connection === "reconnecting" || connection === "closed";
  const label = disconnected
    ? connection === "closed"
      ? "状态连接已断开，正在自动恢复"
      : "状态连接中断，正在重连"
    : primary
      ? activityLabel(primary)
      : fallback;
  const seconds = Math.max(
    0,
    Math.floor((now - (primary?.since || fallbackSince)) / 1000),
  );
  const elapsed =
    seconds < 60
      ? `${seconds} 秒`
      : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return (
    <span
      className="activity-line"
      title={[label, ticking ? `已等待 ${elapsed}` : "", secondary]
        .filter(Boolean)
        .join(" · ")}
    >
      {primary?.phase === "waiting_user" ? (
        <CircleHelp size={13} />
      ) : ticking ? (
        <Busy />
      ) : null}
      <span className="activity-label" role="status" aria-live="polite">
        {label}
      </span>
      {ticking && <time className="activity-elapsed">{elapsed}</time>}
      {secondary && <small className="activity-secondary">{secondary}</small>}
    </span>
  );
}
