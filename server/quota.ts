import { createHash } from "node:crypto";
import { RuntimeManager } from "./runtime.ts";
import { usesWebLogin } from "./auth-config.ts";
import { planRows } from "../shared/usage.ts";
import type { QuotaSnapshot } from "../shared/types.ts";
type Entry = {
  value?: QuotaSnapshot;
  attempted: number;
  next: number;
  failures: number;
  pending?: Promise<QuotaSnapshot>;
};
export class Quotas {
  private entries = new Map<string, Entry>();
  constructor(private runtime: RuntimeManager) {}
  async get(sessionId: string, force = false): Promise<QuotaSnapshot> {
    const session = this.runtime.store.session(sessionId);
    if (!session) throw new Error("会话不存在");
    if (!usesWebLogin(session.repo))
      return {
        rows: [],
        updatedAt: new Date().toISOString(),
        authMode: "token",
        reason: "需在沙箱管理中完成网页登录",
      };
    const connected = [...this.runtime.connections.values()].find(
      (c) => c.session.repo === session.repo && !c.closed,
    );
    const c = connected || (await this.runtime.open(sessionId));
    const account = (c.capabilities?.account || {}) as Record<string, unknown>;
    const identity = account.email
      ? JSON.stringify([
          account.email,
          account.organization,
          account.subscriptionType,
        ])
      : "repo:" + session.repo;
    const key = createHash("sha256").update(identity).digest("hex");
    const entry = this.entries.get(key) || {
      attempted: 0,
      next: 0,
      failures: 0,
    };
    this.entries.set(key, entry);
    if (entry.pending) return entry.pending;
    const now = Date.now();
    if (
      entry.value &&
      ((now < entry.next && (!force || entry.failures > 0)) ||
        now - entry.attempted < 15000)
    )
      return entry.value;
    entry.attempted = now;
    entry.pending = (async () => {
      try {
        const raw = (await this.runtime.control(c.session.id, "usage", [
          { skipBehaviors: true },
        ])) as any;
        const rows = planRows(raw.rate_limits || {});
        if (
          !rows.length &&
          (raw.rate_limits_available === false || raw.rate_limits === null)
        )
          throw new Error("No current plan windows");
        const value: QuotaSnapshot = {
          rows,
          updatedAt: new Date().toISOString(),
          authMode: "web",
        };
        entry.value = value;
        entry.failures = 0;
        entry.next = Date.now() + 60000;
        return value;
      } catch {
        entry.failures++;
        entry.next =
          Date.now() +
          Math.min(600000, 60000 * 2 ** Math.min(entry.failures, 4));
        const value: QuotaSnapshot = {
          rows: entry.value?.rows || [],
          updatedAt: entry.value?.updatedAt || new Date().toISOString(),
          authMode: "web",
          stale: !!entry.value?.rows.length,
          retryAt: new Date(entry.next).toISOString(),
          reason: "套餐用量暂不可用；可能是上游限流或授权失效",
        };
        entry.value = value;
        return value;
      } finally {
        entry.pending = undefined;
      }
    })();
    return entry.pending;
  }
}
