import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export type SavedSettings = {
  setupComplete?: boolean;
  oauth?: string;
  translateUrl?: string;
  translateKey?: string;
  translateModel?: string;
  translatorProtocol?: "auto" | "openai" | "thinking" | "qwen" | "off";
  retentionDays?: number;
  passwordHash?: string;
  defaultRepo?: string;
  webLoginRepos?: string[];
  visionModel?: string;
  visionUrl?: string;
  visionKey?: string;
};

export function loadSettings(directory: string): SavedSettings {
  const path = join(directory, "settings.enc");
  if (!existsSync(path)) return {};
  try {
    const key = readFileSync(join(directory, "vault.key"));
    const data = readFileSync(path),
      decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  } catch {
    throw new Error(
      "无法解密服务器配置。请恢复配套的 settings.enc 与 vault.key。",
    );
  }
}

export function saveSettings(directory: string, value: SavedSettings) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, "vault.key");
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", readFileSync(keyPath), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  const path = join(directory, "settings.enc"),
    temporary = path + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), body]), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

const derive = promisify(scrypt);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (
    parts.length !== 3 ||
    parts[0] !== "scrypt" ||
    !/^[0-9a-f]{32}$/.test(parts[1]) ||
    !/^[0-9a-f]{64}$/.test(parts[2])
  )
    return false;
  return timingSafeEqual(
    (await derive(password, parts[1], 32)) as Buffer,
    Buffer.from(parts[2], "hex"),
  );
}
