import type { Activity, ActivityPhase } from "../shared/activity.ts";
export class Activities {
  private sessions = new Map<string, Map<string, Activity>>();
  constructor(
    private publish: (sessionId: string, values: Activity[]) => void,
  ) {}
  list(sessionId: string) {
    return [...(this.sessions.get(sessionId)?.values() || [])];
  }
  set(
    sessionId: string,
    id: string,
    phase: ActivityPhase,
    options: Pick<Activity, "scope"> &
      Partial<Pick<Activity, "detail" | "runId">>,
  ) {
    const values = this.sessions.get(sessionId) || new Map<string, Activity>(),
      previous = values.get(id);
    const detail = options.detail?.slice(0, 120);
    if (
      previous?.phase === phase &&
      previous.detail === detail &&
      previous.scope === options.scope
    )
      return false;
    values.set(id, {
      id,
      phase,
      ...options,
      detail,
      since: previous?.phase === phase ? previous.since : Date.now(),
    });
    this.sessions.set(sessionId, values);
    this.publish(sessionId, this.list(sessionId));
    return true;
  }
  clear(sessionId: string, id: string) {
    const values = this.sessions.get(sessionId);
    if (!values?.delete(id)) return;
    if (!values.size) this.sessions.delete(sessionId);
    this.publish(sessionId, this.list(sessionId));
  }
  remove(sessionId: string) {
    if (this.sessions.delete(sessionId)) this.publish(sessionId, []);
  }
}
