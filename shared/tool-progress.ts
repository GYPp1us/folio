import type { TraceBlock } from "./types";
export const isToolDetail = (block: TraceBlock) =>
  block.kind === "tool_result" || block.kind === "tool_progress";
export const legacySystemProgress = (block: TraceBlock) =>
  block.kind === "commentary" && block.title === "执行进度";
export const commandOf = (block: TraceBlock) => {
  const data = block.data as
    { name?: string; input?: { command?: unknown } } | undefined;
  return data?.name === "Bash" && typeof data.input?.command === "string"
    ? data.input.command
    : undefined;
};
// Older versions saved SDK system summaries as commentary. Project those records
// into tool details without changing source text or the encrypted historical rows.
export function normalizeProgress(blocks: TraceBlock[]) {
  const calls = new Map<string, TraceBlock>();
  const commands = new Map<string, Map<string, TraceBlock>>();
  return blocks.map((block) => {
    if (block.kind === "tool") {
      calls.set(block.runId + ":" + block.toolId, block);
      const command = commandOf(block);
      if (command !== undefined) {
        let run = commands.get(block.runId);
        if (!run) commands.set(block.runId, (run = new Map()));
        run.set(command.trim(), block);
      }
      return block;
    }
    const legacy = legacySystemProgress(block);
    if (!legacy && block.kind !== "tool_progress") return block;
    const call = block.toolId
      ? calls.get(block.runId + ":" + block.toolId)
      : commands.get(block.runId)?.get(block.original.trim());
    const code = call && commandOf(call)?.trim() === block.original.trim();
    if (
      !legacy &&
      (!call || block.toolId === call.toolId) &&
      (!code || (block.data as any)?.format === "code")
    )
      return block;
    return {
      ...block,
      kind: "tool_progress" as const,
      toolId: block.toolId || call?.toolId,
      data: {
        ...((block.data as object) || {}),
        ...(legacy ? { source: "sdk_system_legacy" } : {}),
        ...(code ? { format: "code", language: "bash" } : {}),
      },
    };
  });
}
