export type Report = {
  id: string;
  title: string;
  repo: string;
  sessionId: string;
  kind: "static" | "service";
  createdAt: string;
  expiresAt?: string;
  state: "running" | "ready" | "stopped" | "error";
  entry: string;
  files?: Record<string, { mime: string; size: number }>;
  size?: number;
  command?: string;
  cwd?: string;
  port?: number;
  catalog?: Record<string, string>;
  translatedCatalog?: Record<string, string>;
  translationState?: "none" | "pending" | "done" | "error";
};
