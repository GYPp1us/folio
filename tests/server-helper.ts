import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
mkdirSync(resolve(".runtime"), { recursive: true });
export const testDirectory = () =>
  mkdtempSync(join(resolve(".runtime"), "setup-test-"));
export async function startServer(
  directory: string,
  token: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const reservation = createServer();
  await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: directory,
        APP_PASSWORD: "",
        APP_SKIP_SETUP: "0",
        CC_SANDBOX_TOKEN: "test-sandbox-token",
        FOLIO_SETUP_TOKEN: token,
        FOLIO_SETUP_TOKEN_FILE: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        TRANSLATOR_URL: "",
        TRANSLATOR_API_KEY: "",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise<void>((r, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("测试服务器启动超时"));
    }, 10000);
    child.stdout.on("data", (c) => {
      if (c.toString().includes("Folio API")) {
        clearTimeout(timer);
        r();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`测试服务器退出 ${code}`));
    });
    child.stderr.on("data", () => {});
  });
  const base = `http://127.0.0.1:${port}/api`;
  return {
    base,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
    },
  };
}
