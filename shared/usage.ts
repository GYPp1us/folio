export type PlanRow = {
  key: string;
  label: string;
  percent: number | null;
  resetsAt?: string;
  severity?: string;
  kind?: string;
};

export type TokenTotals = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
};
const tokenFields = {
  input: ["inputTokens", "input_tokens"],
  output: ["outputTokens", "output_tokens"],
  cacheRead: ["cacheReadInputTokens", "cache_read_input_tokens"],
  cacheWrite: ["cacheCreationInputTokens", "cache_creation_input_tokens"],
} as const;
const counter = (row: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys)
    if (
      typeof row[key] === "number" &&
      Number.isFinite(row[key]) &&
      (row[key] as number) >= 0
    )
      return row[key] as number;
  return null;
};
export function tokenTotals(row: Record<string, unknown>): TokenTotals {
  const values = Object.fromEntries(
    Object.entries(tokenFields).map(([key, aliases]) => [
      key,
      counter(row, aliases),
    ]),
  ) as Omit<TokenTotals, "total">;
  return {
    ...values,
    total: Object.values(values).every((v) => v !== null)
      ? Object.values(values).reduce<number>((sum, n) => sum + n!, 0)
      : null,
  };
}
// SDK model_usage is a cumulative snapshot, including subagents. Never add
// successive results, or add the per-turn main-loop `usage` to this snapshot.
export function mergeUsage(
  previous: Record<string, any> = {},
  next: Record<string, any> = {},
) {
  const models: Record<string, any> = { ...(previous.model_usage || {}) };
  for (const [model, current] of Object.entries(next.model_usage || {}) as [
    string,
    Record<string, unknown>,
  ][]) {
    const saved = models[model] || {},
      merged = { ...saved, ...current };
    for (const aliases of Object.values(tokenFields)) {
      const a = counter(saved, aliases),
        b = counter(current, aliases);
      if (a !== null || b !== null)
        merged[aliases[0]] = Math.max(a ?? 0, b ?? 0);
    }
    models[model] = merged;
  }
  return {
    ...previous,
    ...next,
    total_cost_usd: Math.max(
      Number(previous.total_cost_usd) || 0,
      Number(next.total_cost_usd) || 0,
    ),
    model_usage: models,
  };
}
export function sessionTokens(
  live: Record<string, any> = {},
  saved: Record<string, any> = {},
) {
  const merged = mergeUsage(saved, live);
  const models = Object.entries(merged.model_usage).map(([name, row]) => ({
    name,
    ...tokenTotals(row as Record<string, unknown>),
  }));
  const totals = Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "total"].map((key) => [
      key,
      models.length && models.every((m) => m[key as keyof TokenTotals] !== null)
        ? models.reduce((sum, m) => sum + m[key as keyof TokenTotals]!, 0)
        : null,
    ]),
  ) as TokenTotals;
  return { models, totals };
}
export function planRows(rates: Record<string, any>): PlanRow[] {
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (Array.isArray(rates.limits))
    return rates.limits.map((row: Record<string, any>, i: number) => {
      const name =
        row.label ||
        row.display_name ||
        (
          {
            session: "当前窗口",
            weekly_all: "每周全部模型",
            weekly_scoped: "每周",
          } as Record<string, string>
        )[row.kind] ||
        row.kind ||
        row.group ||
        "用量";
      const scope = [
        row.scope?.model?.display_name,
        row.scope?.surface?.display_name,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        key: String(row.kind || "limit") + "-" + i,
        label: name + (scope ? " · " + scope : ""),
        percent: number(row.percent),
        resetsAt: row.resets_at || undefined,
        severity: row.severity,
        kind: row.kind,
      };
    });
  const names: Record<string, string> = {
    five_hour: "五小时",
    seven_day: "每周",
    seven_day_opus: "Opus 每周",
    seven_day_sonnet: "Sonnet 每周",
    seven_day_oauth_apps: "OAuth 应用每周",
  };
  return Object.entries(rates)
    .filter(
      ([key, value]) =>
        key !== "extra_usage" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "utilization" in value,
    )
    .map(([key, row]) => ({
      key,
      label: names[key] || key,
      percent: number(row.utilization),
      resetsAt: row.resets_at || undefined,
      kind:
        key === "five_hour"
          ? "session"
          : key === "seven_day"
            ? "weekly_all"
            : "weekly_scoped",
    }));
}

export function sandboxTokens(
  sessions: {
    id: string;
    sdkSessionId?: string;
    usage?: Record<string, any>;
  }[],
) {
  const unique = new Map<string, Record<string, any>>(),
    usedKeys = new Set<string>();
  for (const session of sessions) {
    const key = session.sdkSessionId || session.id;
    const value = session.usage || {};
    if (session.sdkSessionId || Object.keys(value.model_usage || {}).length)
      usedKeys.add(key);
    // An unused Folio session contributes zero. An initialized SDK session
    // without a snapshot remains unknown and must not silently count as zero.
    const empty =
      !session.sdkSessionId && !Object.keys(value.model_usage || {}).length;
    unique.set(
      key,
      mergeUsage(unique.get(key), empty ? { model_usage: {} } : value),
    );
  }
  const fields = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const;
  const known = Object.fromEntries(fields.map((key) => [key, 0])) as Record<
    (typeof fields)[number],
    number
  >;
  const totals = { ...known } as TokenTotals;
  let pendingSessions = 0;
  const models = new Map<string, TokenTotals>();
  for (const [key, usage] of unique) {
    const token = sessionTokens(usage);

    if (!token.models.length && !usedKeys.has(key)) continue;
    if (token.totals.total === null) pendingSessions++;
    for (const field of fields) {
      const count = token.totals[field];
      if (count === null) totals[field] = null;
      else {
        known[field] += count;
        if (totals[field] !== null) totals[field]! += count;
      }
    }
    for (const model of token.models) {
      const saved =
        models.get(model.name) ||
        ({
          ...Object.fromEntries(fields.map((field) => [field, 0])),
        } as TokenTotals);
      for (const field of fields)
        saved[field] =
          saved[field] === null || model[field] === null
            ? null
            : saved[field]! + model[field]!;
      models.set(model.name, saved);
    }
  }
  return {
    totals,
    knownTotals: known,
    pendingSessions,
    sessionCount: sessions.length,
    sdkSessionCount: unique.size,
    models: [...models].map(([name, values]) => ({ name, ...values })),
  };
}
export type SandboxUsage = ReturnType<typeof sandboxTokens> & { repo: string };
