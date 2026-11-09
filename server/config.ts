import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadSettings, saveSettings, type SavedSettings } from "./settings.ts";
const directory = process.env.DATA_DIR || ".runtime";
const saved = loadSettings(directory);
export const config = {
  port: Number(process.env.PORT || 3210),
  host: process.env.HOST || "127.0.0.1",
  sandboxUrl: process.env.CC_SANDBOX_URL || "http://127.0.0.1:8123",
  token:
    process.env.CC_SANDBOX_TOKEN ||
    (process.env.CC_SANDBOX_TOKEN_FILE
      ? readFileSync(process.env.CC_SANDBOX_TOKEN_FILE, "utf8").trim()
      : ""),
  oauth: saved.oauth ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  translateUrl: saved.translateUrl ?? process.env.TRANSLATOR_URL ?? "",
  translateKey: saved.translateKey ?? process.env.TRANSLATOR_API_KEY ?? "",
  translateModel:
    saved.translateModel ?? process.env.TRANSLATOR_MODEL ?? "qwen2.5:7b",
  translatorProtocol:
    saved.translatorProtocol ||
    (process.env.TRANSLATOR_PROTOCOL as typeof saved.translatorProtocol) ||
    ("auto" as "auto" | "openai" | "thinking" | "qwen" | "off"),
  retentionDays:
    saved.retentionDays ?? Number(process.env.RETENTION_DAYS || 30),
  dataDir: directory,
  password: saved.passwordHash ? "" : process.env.APP_PASSWORD || "",
  passwordHash: saved.passwordHash || "",
  setupComplete: process.env.APP_SKIP_SETUP === "1" || !!saved.setupComplete,
  setupToken:
    process.env.FOLIO_SETUP_TOKEN ||
    (process.env.FOLIO_SETUP_TOKEN_FILE
      ? readFileSync(process.env.FOLIO_SETUP_TOKEN_FILE, "utf8").trim()
      : ""),
  defaultRepo: saved.defaultRepo || "my-project",
  webLoginRepos: saved.webLoginRepos || [],
  visionModel: saved.visionModel ?? process.env.VISION_TRANSLATOR_MODEL ?? "",
  visionUrl: saved.visionUrl ?? process.env.VISION_TRANSLATOR_URL ?? "",
  visionKey: saved.visionKey ?? process.env.VISION_TRANSLATOR_KEY ?? "",
};
export const hasPassword = () => !!(config.password || config.passwordHash);
export function persistConfig(overrides: SavedSettings = {}) {
  const settings: SavedSettings = {
    setupComplete: config.setupComplete,
    oauth: config.oauth,
    translateUrl: config.translateUrl,
    translateKey: config.translateKey,
    translateModel: config.translateModel,
    translatorProtocol: config.translatorProtocol,
    retentionDays: config.retentionDays,
    passwordHash: config.passwordHash,
    defaultRepo: config.defaultRepo,
    webLoginRepos: config.webLoginRepos,
    visionModel: config.visionModel,
    visionUrl: config.visionUrl,
    visionKey: config.visionKey,
    ...overrides,
  };
  saveSettings(config.dataDir, settings);
  Object.assign(config, settings);
  if (config.passwordHash) config.password = "";
}
if (
  !["127.0.0.1", "localhost", "::1"].includes(config.host) &&
  !hasPassword() &&
  !config.setupToken
)
  throw new Error("非 loopback 监听必须设置 APP_PASSWORD");
