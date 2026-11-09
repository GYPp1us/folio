export type Strategy = "pending" | "placeholder" | "env" | "pass" | "rewrite";
export type ReviewMode = "automatic" | "manual" | "direct";
export type DownstreamMode = "all" | "messages" | "manual";
export type PermissionMode =
  "auto" | "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
export type Effort =
  "default" | "off" | "low" | "medium" | "high" | "xhigh" | "max";
export type Finding = {
  id: string;
  kind: string;
  label: string;
  value: string;
  start: number;
  end: number;
  severity: "high" | "medium";
  token: string;
  envName: string;
  strategy: Strategy;
  secret: boolean;
};
export type Review = {
  id: string;
  sessionId: string;
  original: string;
  findings: Finding[];
  status: "review" | "preparing" | "prepared" | "running" | "done";
  english?: string;
  masked?: string;
  createdAt: string;
  mode: ReviewMode;
  steering: boolean;
  attachments?: string[];
  attachmentVersions?: Record<string, number>;
};
export type Session = {
  id: string;
  title: string;
  repo: string;
  sdkSessionId?: string;
  stateVolume: string;
  workVolume: string;
  createdAt: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: Effort;
  usage?: Record<string, unknown>;
  downstreamMode?: DownstreamMode;
};
export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  original: string;
  chinese: string;
  createdAt: string;
  kind?: string;
  sdkUuid?: string;
  runId?: string;
  attachments?: string[];
  blockId?: string;
};
export type RunEvent = {
  seq: number;
  type:
    | "status"
    | "original"
    | "translation"
    | "tool"
    | "permission"
    | "dialog"
    | "usage"
    | "user"
    | "task"
    | "notification"
    | "done"
    | "error";
  text?: string;
  data?: unknown;
};
export type TranslationState = "none" | "pending" | "done" | "error";
export type TraceBlock = {
  id: string;
  sessionId: string;
  runId: string;
  createdAt: string;
  kind:
    | "final"
    | "commentary"
    | "tool_description"
    | "thinking"
    | "tool"
    | "tool_progress"
    | "tool_result";
  title: string;
  original: string;
  chinese?: string;
  data?: unknown;
  toolId?: string;
  parentToolId?: string;
  messageId?: string;
  translationState: TranslationState;
  translationError?: string;
};
export type Asset = {
  id: string;
  sessionId: string;
  createdAt: string;
  name: string;
  mime: string;
  size: number;
  digest: string;
  origin: "upload" | "output";
  kind: "image" | "html" | "pdf" | "text" | "file";
  approval: "ready" | "pending";
  scan: "exempt" | "clean" | "findings" | "unscanned";
  findings?: Finding[];
  revision: number;
  sandboxPath?: string;
  sourcePath?: string;
  publishedRuns?: string[];
  title?: string;
  children?: string[];
  catalog?: Record<string, string>;
  translatedCatalog?: Record<string, string>;
  description?: string;
  descriptionZh?: string;
  translationState: TranslationState;
  translationError?: string;
  previewReady?: boolean;
  previewError?: string;
  inlineKey?: string;
};
export type SessionSnapshot = {
  activities?: import("./activity").Activity[];
  session: Session;
  messages: Message[];
  blocks: TraceBlock[];
  assets: Asset[];
  runId?: string;
};
export type QuotaSnapshot = {
  rows: import("./usage").PlanRow[];
  updatedAt: string;
  authMode: "token" | "web";
  stale?: boolean;
  retryAt?: string;
  reason?: string;
};
export type PublicConfig = {
  translator: string;
  translatorUrl: string;
  translatorReady: boolean;
  translatorProtocol: "auto" | "openai" | "thinking" | "qwen" | "off";
  sandboxUrl: string;
  oauthConfigured: boolean;
  retentionDays: number;
  authRequired: boolean;
  defaultRepo: string;
  visionModel?: string;
  visionUrl?: string;
};
export type ModelInfo = {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAutoMode?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
};
export type CommandInfo = {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
};
export type Capabilities = {
  models: ModelInfo[];
  commands: CommandInfo[];
  agents: unknown[];
  account: unknown;
  outputStyles: string[];
  version?: string;
  tools: string[];
  permissionModes: PermissionMode[];
  controls: ControlDescriptor[];
  unavailable: Record<string, string>;
  updatedAt: string;
};
export type ControlDescriptor = {
  method: string;
  label: string;
  group: string;
  args: string;
  mutation?: boolean;
};
export type SandboxLogin = {
  id: string;
  repo: string;
  status:
    "starting" | "awaiting" | "verifying" | "complete" | "error" | "cancelled";
  url?: string;
  error?: string;
  expiresAt: string;
};
