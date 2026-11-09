import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";
import { config } from "./config.ts";
import { Activities } from "./activity.ts";
import {
  normalizeProgress,
  legacySystemProgress,
} from "../shared/tool-progress.ts";
import type {
  Finding,
  Message,
  Session,
  Asset,
  TraceBlock,
} from "../shared/types.ts";

export class Store {
  db: DatabaseSync;
  key: Buffer;
  events = new EventEmitter();
  activities = new Activities((id, activities) =>
    this.notify(id, { activities }),
  );
  constructor(public directory = config.dataDir) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "vault.key");
    if (!existsSync(path))
      writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(path);
    this.db = new DatabaseSync(join(directory, "workspace.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,created);
      CREATE INDEX IF NOT EXISTS blocks_session ON blocks(session_id,created);
      CREATE INDEX IF NOT EXISTS assets_session ON assets(session_id,created);
      CREATE TABLE IF NOT EXISTS app_meta (id TEXT PRIMARY KEY);`);
    if (
      !this.db
        .prepare("SELECT id FROM app_meta WHERE id=?")
        .get("reply-default-v2")
    ) {
      this.db.exec("BEGIN");
      try {
        for (const session of this.sessions())
          if (!session.downstreamMode || session.downstreamMode === "all")
            this.save({ ...session, downstreamMode: "messages" });
        this.db
          .prepare("INSERT INTO app_meta VALUES (?)")
          .run("reply-default-v2");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    this.db
      .prepare("DELETE FROM sessions WHERE created < ?")
      .run(Date.now() - config.retentionDays * 86400000);
    mkdirSync(join(directory, "assets"), { recursive: true, mode: 0o700 });
    this.cleanupAssets();
    // Requests interrupted by a service restart remain available for manual retry.
    for (const table of ["blocks", "assets"]) {
      const rows = this.db.prepare(`SELECT id,data FROM ${table}`).all() as {
        id: string;
        data: string;
      }[];
      for (const row of rows) {
        const value = this.open<TraceBlock | Asset>(row.data);
        if (value.translationState === "pending") {
          value.translationState = "error";
          value.translationError = "服务重启中断了翻译，可点击重试。";
          this.db
            .prepare(`UPDATE ${table} SET data=? WHERE id=?`)
            .run(this.seal(value), row.id);
        }
      }
    }
  }
  seal(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  open<T>(value: string): T {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString(),
    );
  }
  sessions(): Session[] {
    return (
      this.db
        .prepare("SELECT data FROM sessions ORDER BY created DESC")
        .all() as { data: string }[]
    ).map((r) => this.open<Session>(r.data));
  }
  session(id: string) {
    const row = this.db
      .prepare("SELECT data FROM sessions WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? this.open<Session>(row.data) : undefined;
  }
  create(repo: string): Session {
    const s: Session = {
      id: randomUUID(),
      repo,
      title: "新会话",
      downstreamMode: "messages",
      stateVolume: `cc-state-${repo}`,
      workVolume: `cc-work-${repo}`,
      createdAt: new Date().toISOString(),
    };
    this.save(s);
    return s;
  }
  save(s: Session) {
    this.db
      .prepare(
        "INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(s.id, this.seal(s), Date.parse(s.createdAt));
  }
  messages(id: string, limit?: number): Message[] {
    const rows = limit
      ? this.db
          .prepare(
            "SELECT data FROM messages WHERE session_id=? ORDER BY created DESC,rowid DESC LIMIT ?",
          )
          .all(id, limit)
          .reverse()
      : this.db
          .prepare(
            "SELECT data FROM messages WHERE session_id=? ORDER BY created,rowid",
          )
          .all(id);
    return (rows as { data: string }[]).map((row) =>
      this.open<Message>(row.data),
    );
  }
  add(id: string, message: Omit<Message, "id" | "createdAt">) {
    const m = {
      ...message,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO messages VALUES (?, ?, ?, ?)")
      .run(m.id, id, this.seal(m), Date.now());
    this.notify(id, { message: m });
    return m;
  }
  notify(sessionId: string, value: Record<string, unknown>) {
    this.events.emit("change", { sessionId, ...value });
  }
  updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const row = this.db
      .prepare("SELECT data FROM messages WHERE id=? AND session_id=?")
      .get(id, sessionId) as { data: string } | undefined;
    const previous = row ? this.open<Message>(row.data) : undefined;
    if (!previous) throw new Error("消息不存在");
    const value = { ...previous, ...update, id: previous.id };
    this.db
      .prepare("UPDATE messages SET data=? WHERE id=? AND session_id=?")
      .run(this.seal(value), id, sessionId);
    this.notify(sessionId, { message: value });
    return value;
  }
  blocks(sessionId: string): TraceBlock[] {
    return normalizeProgress(
      (
        this.db
          .prepare(
            "SELECT data FROM blocks WHERE session_id=? ORDER BY created,rowid",
          )
          .all(sessionId) as { data: string }[]
      ).map((r) => this.open<TraceBlock>(r.data)),
    );
  }
  block(id: string): TraceBlock | undefined {
    const row = this.db
      .prepare("SELECT data FROM blocks WHERE id=?")
      .get(id) as { data: string } | undefined;
    const block = row ? this.open<TraceBlock>(row.data) : undefined;
    return block && legacySystemProgress(block)
      ? this.blocks(block.sessionId).find((value) => value.id === id)
      : block;
  }
  saveBlock(block: TraceBlock) {
    this.db
      .prepare(
        "INSERT INTO blocks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        block.id,
        block.sessionId,
        this.seal(block),
        Date.parse(block.createdAt),
      );
    this.notify(block.sessionId, { block });
    return block;
  }
  assets(sessionId: string): Asset[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM assets WHERE session_id=? ORDER BY created,rowid",
        )
        .all(sessionId) as { data: string }[]
    ).map((r) => this.open<Asset>(r.data));
  }
  asset(id: string): Asset | undefined {
    const row = this.db
      .prepare("SELECT data FROM assets WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? this.open<Asset>(row.data) : undefined;
  }
  saveAsset(asset: Asset) {
    this.db
      .prepare(
        "INSERT INTO assets VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        asset.id,
        asset.sessionId,
        this.seal(asset),
        Date.parse(asset.createdAt),
      );
    this.notify(asset.sessionId, { asset });
    return asset;
  }
  writeAsset(asset: Asset, bytes: Buffer) {
    if (!/^[0-9a-f-]{36}$/.test(asset.id)) throw new Error("附件编号无效");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    writeFileSync(
      join(this.directory, "assets", asset.id + ".bin"),
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      { mode: 0o600, flag: "wx" },
    );
    return this.saveAsset(asset);
  }
  assetBytes(id: string) {
    if (!this.asset(id) || !/^[0-9a-f-]{36}$/.test(id))
      throw new Error("附件不存在");
    const bytes = readFileSync(join(this.directory, "assets", id + ".bin")),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
  writeDerivative(id: string, bytes: Buffer) {
    if (!this.asset(id)) throw new Error("附件不存在");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv),
      body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    writeFileSync(
      join(this.directory, "assets", id + ".preview.bin"),
      Buffer.concat([iv, cipher.getAuthTag(), body]),
      { mode: 0o600 },
    );
  }
  derivative(id: string) {
    if (!this.asset(id)) throw new Error("附件不存在");
    const bytes = readFileSync(
        join(this.directory, "assets", id + ".preview.bin"),
      ),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]);
  }
  cleanupAssets() {
    const ids = new Set(
      (this.db.prepare("SELECT id FROM assets").all() as { id: string }[]).map(
        (r) => r.id + ".bin",
      ),
    );
    for (const file of readdirSync(join(this.directory, "assets")))
      if (
        /^[0-9a-f-]{36}(\.preview)?\.bin$/.test(file) &&
        !ids.has(file.replace(".preview.bin", ".bin"))
      )
        unlinkSync(join(this.directory, "assets", file));
  }
  bindings(id: string): Finding[] {
    const r = this.db
      .prepare("SELECT data FROM bindings WHERE session_id = ?")
      .get(id) as { data: string } | undefined;
    return r ? this.open(r.data) : [];
  }
  visibleMessages(id: string, limit?: number): Message[] {
    const all = this.messages(id, limit);
    return all.filter(
      (message, index) =>
        message.kind !== "demo" &&
        !(message.role === "user" && all[index + 1]?.kind === "demo"),
    );
  }
  bind(id: string, findings: Finding[]) {
    const all = [...this.bindings(id), ...findings];
    this.db
      .prepare(
        "INSERT INTO bindings VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, this.seal(all));
  }
  remove(id: string) {
    this.activities.remove(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.cleanupAssets();
  }
  close() {
    this.db.close();
  }
}
