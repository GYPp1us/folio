import { createHash, createHmac } from "node:crypto";
import { config } from "./config.ts";
import type { Store } from "./store.ts";
export const LOGIN_SECONDS = 30 * 86400;
export type LoginRegistry = {
  get(token: string): number | undefined;
  set(token: string, expires: number): unknown;
  clear(): void;
};
export class DeviceLogins implements LoginRegistry {
  constructor(private store: Store) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS device_logins (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS device_login_scope (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
    );
    this.ensureScope();
    this.prune();
  }
  private digest(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  private scope() {
    return createHmac("sha256", this.store.key)
      .update(
        config.setupComplete
          ? "password:" + (config.passwordHash || config.password)
          : "installer:" + config.setupToken,
      )
      .digest("hex");
  }
  private checkedScope = "";
  private ensureScope() {
    const scope = this.scope();
    if (this.checkedScope === scope) return scope;
    const row = this.store.db
      .prepare("SELECT data FROM device_login_scope WHERE id=1")
      .get() as { data: string } | undefined;
    let previous = "";
    try {
      if (row) previous = this.store.open<{ scope: string }>(row.data).scope;
    } catch {}
    if (previous !== scope) {
      this.clear();
      this.store.db
        .prepare(
          "INSERT INTO device_login_scope VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(this.store.seal({ scope }));
    }
    this.checkedScope = scope;
    return scope;
  }
  get(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    const scope = this.ensureScope();
    const row = this.store.db
      .prepare("SELECT expires,data FROM device_logins WHERE id=?")
      .get(this.digest(token)) as { expires: number; data: string } | undefined;
    if (!row || row.expires <= Date.now()) return undefined;
    try {
      return this.store.open<{ scope: string }>(row.data).scope === scope
        ? row.expires
        : undefined;
    } catch {
      return undefined;
    }
  }
  set(token: string, expires: number): this {
    const scope = this.ensureScope();
    this.store.db
      .prepare(
        "INSERT INTO device_logins VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data",
      )
      .run(this.digest(token), expires, this.store.seal({ scope }));
    return this;
  }
  delete(token: string) {
    return !!this.store.db
      .prepare("DELETE FROM device_logins WHERE id=?")
      .run(this.digest(token)).changes;
  }
  clear() {
    this.store.db.exec("DELETE FROM device_logins");
  }
  prune() {
    this.store.db
      .prepare("DELETE FROM device_logins WHERE expires<=?")
      .run(Date.now());
  }
}
