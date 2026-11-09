export type ActivityPhase =
  | "checking"
  | "queued"
  | "preparing"
  | "sending"
  | "waiting_model"
  | "thinking"
  | "receiving"
  | "waiting_tool"
  | "waiting_user"
  | "compacting"
  | "retrying"
  | "translation_queued"
  | "translating"
  | "preparing_output"
  | "interrupting";
export type Activity = {
  id: string;
  scope: "upstream" | "run" | "downstream";
  phase: ActivityPhase;
  since: number;
  detail?: string;
  runId?: string;
};
export function activityLabel(activity: Activity) {
  const labels: Record<ActivityPhase, string> = {
    checking: "正在检查输入",
    queued: "等待发送",
    preparing: "正在准备会话",
    sending: "正在传递",
    waiting_model: "等待模型响应",
    thinking: "正在思考",
    receiving: "正在接收回复",
    waiting_tool: "等待工具",
    waiting_user: "等待你的确认",
    compacting: "正在压缩上下文",
    retrying: "模型请求重试",
    translation_queued: "等待翻译",
    translating:
      activity.scope === "upstream" ? "正在翻译输入" : "正在翻译输出",
    preparing_output: "正在处理产物",
    interrupting: "正在中断",
  };
  return (
    labels[activity.phase] + (activity.detail ? " · " + activity.detail : "")
  );
}
export function activitySummary(activities: Activity[]) {
  const outgoing = activities.filter((a) => a.scope === "upstream"),
    run = activities.find((a) => a.scope === "run"),
    incoming = activities.filter((a) => a.scope === "downstream");
  const primary =
    outgoing.at(-1) ||
    run ||
    incoming.find((a) => a.phase !== "translation_queued") ||
    incoming[0];
  const secondary: string[] = [];
  if (outgoing.length && run) secondary.push(activityLabel(run));
  if (primary?.scope !== "downstream" && incoming.length)
    secondary.push(`输出处理中 ${incoming.length} 项`);
  if (primary?.scope === "downstream" && incoming.length > 1)
    secondary.push(`共 ${incoming.length} 项`);
  return { primary, secondary: secondary.join(" · ") };
}
