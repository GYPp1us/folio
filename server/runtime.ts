import { activityLabel, type ActivityPhase } from "../shared/activity.ts";
import { randomUUID } from "node:crypto";
import {
  query,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
  type Options,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "./config.ts";
import { claudeEnv, usesWebLogin } from "./auth-config.ts";
import { sandbox, makeSandboxSpawner } from "./sandbox.ts";
import { controls, usageMethod } from "./controls.ts";
import { detect, maskOutput, restore } from "./privacy.ts";
import { recentDialogue, translate } from "./translator.ts";
import { MediaService, PAGE_CONTRACT } from "./media.ts";
import { Reports } from "./reports.ts";
import { translateInteraction } from "./interaction.ts";
import { BlockTranslations } from "./translations.ts";
import { mergeUsage } from "../shared/usage.ts";
import type { Store } from "./store.ts";
import type {
  Capabilities,
  Effort,
  PermissionMode,
  Review,
  RunEvent,
  Session,
  TraceBlock,
  DownstreamMode,
} from "../shared/types.ts";

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiter?: (value: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  push(value: SDKUserMessage) {
    if (this.ended) throw new Error("SDK 连接已关闭");
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }
  close() {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> =>
        this.values.length
          ? Promise.resolve({ value: this.values.shift()!, done: false })
          : this.ended
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => (this.waiter = resolve)),
      return: async () => {
        this.close();
        return { value: undefined, done: true as const };
      },
    };
  }
}
export type Run = {
  id: string;
  sessionId: string;
  repo: string;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  done: boolean;
  output: string;
  streamed: boolean;
  generation: number;
  startedAt: number;
  interrupted: boolean;
  pendingSteering?: Set<string>;
  lastBlockId?: string;
  pendingTools?: Map<string, string>;
  blockKinds?: Map<number, string>;
  tools?: Map<string, { name: string; command?: string }>;
  taskTools?: Map<string, string>;
  streamSample?: { first?: number; last?: number; tokens?: number };
  streamTotals?: { ms: number; tokens: number };
};
type Connection = {
  session: Session;
  q: Query;
  input: InputQueue;
  controller: AbortController;
  ready: Promise<Capabilities>;
  capabilities?: Capabilities;
  run?: Run;
  lastUsed: number;
  closed: boolean;
  drain: Promise<void>;
  finalize: Promise<void>;
  bypass: boolean;
};
type Reply = {
  allow?: boolean;
  updatedInput?: Record<string, unknown>;
  content?: Record<string, string | number | boolean | string[]>;
  result?: Record<string, unknown>;
  message?: string;
};
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export type RunOptions = {
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  downstreamMode?: DownstreamMode;
};
export class RuntimeManager {
  connections = new Map<string, Connection>();
  runs = new Map<string, Run>();
  opening = new Map<string, Promise<Connection>>();
  dispatches = new Map<string, Promise<unknown>>();
  reservations = new Map<string, string>();
  questions = new Map<
    string,
    { runId: string; finish: (reply: Reply) => void }
  >();
  media: MediaService;
  translations: BlockTranslations;
  reports: Reports;
  constructor(public store: Store) {
    this.media = new MediaService(store);
    this.translations = new BlockTranslations(store);
    this.reports = new Reports(store);
  }
  authBusy = (repo: string) => false;
  isBusy(repo: string) {
    return [...this.connections.values()].some(
      (c) => c.session.repo === repo && c.run && !c.run.done,
    );
  }
  activeFor(id: string) {
    return this.connections.get(id)?.run;
  }
  emit(run: Run, event: Omit<RunEvent, "seq">) {
    const e = { ...event, seq: run.events.length + 1 };
    run.events.push(e);
    for (const listener of run.listeners) listener(e);
  }
  async bounded<T>(promise: Promise<T>, ms = 20000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(fail("SDK 控制请求超时；请重连或重建沙箱", 504)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async open(id: string, bypass = false): Promise<Connection> {
    const currentSession = this.store.session(id);
    if (currentSession && this.authBusy(currentSession.repo))
      throw fail("请先完成或取消此沙箱的网页登录。", 409);
    const existing = this.connections.get(id);
    if (existing && !existing.closed && (!bypass || existing.bypass)) {
      existing.lastUsed = Date.now();
      await existing.ready;
      return existing;
    }
    if (this.opening.has(id)) return this.opening.get(id)!;
    const work = this.create(id, bypass);
    this.opening.set(id, work);
    try {
      return await work;
    } finally {
      this.opening.delete(id);
    }
  }
  private async create(id: string, bypass: boolean): Promise<Connection> {
    const session = this.store.session(id);
    if (!session) throw fail("会话不存在", 404);
    if (
      this.reservations.has(session.repo) &&
      this.reservations.get(session.repo) !== id
    )
      throw fail("沙箱正在准备另一会话", 409);
    if ((!config.oauth && !usesWebLogin(session.repo)) || !config.token)
      throw fail("未配置 Claude 登录或沙箱连接。");
    for (const connection of this.connections.values())
      if (connection.session.repo === session.repo) {
        if (connection.run && !connection.run.done)
          throw fail("当前沙箱已有执行中的会话", 409);
        await this.close(connection.session.id);
      }
    await sandbox("/sandbox/start", "POST", { repo: session.repo });
    if (this.authBusy(session.repo))
      throw fail("请先完成或取消此沙箱的网页登录。", 409);
    const input = new InputQueue(),
      controller = new AbortController();
    const env = claudeEnv(session.repo);
    for (const finding of this.store.bindings(id))
      if (finding.strategy === "env" && !finding.secret)
        env[finding.envName] = finding.value;
    let connection!: Connection;
    const publisher = createSdkMcpServer({
      name: "folio",
      version: "1.0.0",
      alwaysLoad: true,
      instructions: PAGE_CONTRACT,
      tools: [
        tool(
          "publish_file",
          "Publish a generated /work/ file, image, or self-contained HTML page for the user.",
          { path: z.string().max(2048), title: z.string().max(120).optional() },
          async ({ path, title }) => {
            try {
              const run = connection?.run;
              if (!run) throw new Error("No active Folio run");
              const asset = await this.media.publish(
                connection.session.id,
                run.id,
                path,
                title,
              );
              let reportUrl: string | undefined;
              if (asset.kind === "html") {
                const report = await this.reports.snapshot(
                  {
                    id: randomUUID(),
                    title: title || asset.name,
                    repo: connection.session.repo,
                    sessionId: connection.session.id,
                    kind: "static",
                    createdAt: new Date().toISOString(),
                    state: "ready",
                    entry: "index.html",
                  },
                  {
                    "index.html": this.store
                      .derivative(asset.id)
                      .toString("base64"),
                  },
                );
                reportUrl = `/report/${report.id}/`;
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      asset_id: asset.id,
                      name: asset.name,
                      kind: asset.kind,
                      private_url: `folio-asset://${asset.id}`,
                      published: true,
                      ...(reportUrl ? { report_url: reportUrl } : {}),
                    }),
                  },
                ],
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: /翻译|本地化|字典|i18n|translat|localiz|dictionary/i.test(
                      (error as Error).message,
                    )
                      ? "Unable to prepare this file for preview. Please use a self-contained page and local assets."
                      : (error as Error).message,
                  },
                ],
              };
            }
          },
          {
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        ),
        tool(
          "publish_service",
          "Publish a static website/build directory or start a temporary web service and return its URL. Use this proactively for reports, demos and web apps.",
          {
            path: z.string().max(2048).optional(),
            title: z.string().max(120),
            command: z.string().min(1).max(8000).optional(),
            cwd: z.string().max(2048).optional(),
            port: z.number().int().min(1024).max(65535).optional(),
            ttlMinutes: z.number().int().min(5).max(1440).optional(),
          },
          async (options) => {
            try {
              if (!connection?.run) throw new Error("No active run");
              const report = await this.reports.publish(
                connection.session.id,
                options,
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      url: `/report/${report.id}/`,
                      kind: report.kind,
                      state: report.state,
                      expires_at: report.expiresAt,
                    }),
                  },
                ],
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  { type: "text" as const, text: (error as Error).message },
                ],
              };
            }
          },
          {
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true,
            },
          },
        ),
      ],
    });
    const q = query({
      prompt: input,
      options: {
        cwd: "/work",
        resume: session.sdkSessionId,
        model: session.model,
        permissionMode: "default",
        allowDangerouslySkipPermissions: bypass,
        env,
        settingSources: ["user", "project", "local"],
        mcpServers: { folio: publisher },
        spawnClaudeCodeProcess: makeSandboxSpawner(session.repo),
        pathToClaudeCodeExecutable: "/opt/cc-sandbox/image/claude",
        abortController: controller,
        includePartialMessages: true,
        forwardSubagentText: true,
        enableFileCheckpointing: true,
        stderr: () => {},
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "Respond in English. Preserve __YJ_*__ privacy placeholders exactly; never infer their hidden values. Do not print user-approved environment variable values into model context or logs. " +
            PAGE_CONTRACT,
        },
        canUseTool: async (name, originalInput) => {
          const answer = await this.ask(
            connection,
            "permission",
            `工具授权：${name}`,
            { name, input: originalInput },
          );
          return answer.allow
            ? {
                behavior: "allow",
                updatedInput: { ...originalInput, ...answer.updatedInput },
              }
            : {
                behavior: "deny",
                message: answer.message || "The user denied this action.",
              };
        },
        onElicitation: async (request) => {
          const answer = await this.ask(connection, "dialog", "MCP 请求输入", {
            kind: "elicitation",
            request,
          });
          return answer.allow
            ? { action: "accept", content: answer.content || {} }
            : { action: "cancel" };
        },
        onUserDialog: async (request) => {
          if (request.dialogKind !== "refusal_fallback_prompt")
            return { behavior: "cancelled" };
          const answer = await this.ask(
            connection,
            "dialog",
            "Claude Code 请求确认",
            { kind: "user-dialog", request },
          );
          return answer.allow
            ? { behavior: "completed", result: answer.result || {} }
            : { behavior: "cancelled" };
        },
        supportedDialogKinds: ["refusal_fallback_prompt"],
      },
    });
    connection = {
      session,
      q,
      input,
      controller,
      lastUsed: Date.now(),
      closed: false,
      bypass,
      ready: Promise.resolve(undefined as never),
      drain: Promise.resolve(),
      finalize: Promise.resolve(),
    };
    this.connections.set(id, connection);
    connection.drain = this.consume(connection);
    connection.ready = this.bounded(q.initializationResult())
      .then((init) => {
        const auto = init.models.some(
          (model) => model.supportsAutoMode === true,
        );
        const result: Capabilities = {
          models: init.models,
          commands: init.commands,
          agents: init.agents,
          account: init.account,
          outputStyles: init.available_output_styles || [],
          tools: [],
          controls,
          permissionModes: auto
            ? [
                "auto",
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "bypassPermissions",
              ]
            : [
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "bypassPermissions",
              ],
          unavailable: {},
          updatedAt: new Date().toISOString(),
        };
        connection.capabilities = result;
        return result;
      })
      .catch(async (error) => {
        await this.close(id);
        throw error;
      });
    await connection.ready;
    return connection;
  }
  async capabilities(id: string, refresh = false) {
    const session = this.store.session(id);
    if (!session) throw fail("会话不存在", 404);
    const active = [...this.connections.values()].find(
      (c) =>
        c.session.repo === session.repo &&
        c.session.id !== id &&
        c.run &&
        !c.run.done,
    );
    if (active?.capabilities) return active.capabilities;
    const c = await this.open(id);
    if (refresh && !c.run?.done && c.run)
      return { ...c.capabilities!, updatedAt: new Date().toISOString() };
    if (refresh) {
      const init = await this.bounded(c.q.reinitialize());
      Object.assign(c.capabilities!, {
        models: init.models,
        commands: init.commands,
        agents: init.agents,
        account: init.account,
        outputStyles: init.available_output_styles,
        updatedAt: new Date().toISOString(),
      });
    }
    return c.capabilities!;
  }
  async ask(
    c: Connection,
    type: "permission" | "dialog",
    text: string,
    data: Record<string, unknown>,
  ): Promise<Reply> {
    const run = c?.run;
    if (!run || run.done) return { allow: false };
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish({ allow: false, message: "User confirmation timed out." }),
        300000,
      );
      const aborted = () => finish({ allow: false });
      const finish = (reply: Reply) => {
        clearTimeout(timer);
        c.controller.signal.removeEventListener("abort", aborted);
        this.questions.delete(id);
        if (!run.done) this.waitForWork(c);
        this.emit(run, { type: "notification", data: { answered: id } });
        resolve(reply);
      };
      this.questions.set(id, { runId: run.id, finish });
      c.controller.signal.addEventListener("abort", aborted, { once: true });
      if (c.controller.signal.aborted) aborted();
      else {
        this.phase(c, "waiting_user");
        const payload = { ...data, id };
        this.emit(run, { type, text, data: payload });
        void translateInteraction(this.store, c.session.id, data)
          .then((translated) => {
            if (!this.questions.has(id) || run.done) return;
            Object.assign(payload, { translated });
            this.emit(run, {
              type: "notification",
              data: { interaction: { id, translated } },
            });
          })
          .catch(() => {
            if (this.questions.has(id) && !run.done) {
              Object.assign(payload, { translationError: true });
              this.emit(run, {
                type: "notification",
                data: { interaction: { id, translationError: true } },
              });
            }
          });
      }
    });
  }
  async answer(id: string, reply: Reply) {
    const pending = this.questions.get(id);
    if (!pending) throw fail("交互请求已结束", 404);
    const run = this.runs.get(pending.runId),
      sessionId = run?.sessionId;
    if (!sessionId) throw fail("会话不存在", 404);
    const bindings = this.store.bindings(sessionId);
    const context = recentDialogue(
      this.store.visibleMessages(sessionId),
      bindings,
    );
    const convert = async (value: unknown): Promise<any> => {
      if (typeof value === "string") {
        if (
          detect(value).length ||
          bindings.some((b) => value.includes(b.value))
        )
          throw fail(
            "回答含敏感信息。请取消此询问，改用输入框发送并完成隐私选择。",
          );
        if (!/\p{Script=Han}/u.test(value)) return value;
        this.store.activities.set(sessionId, "answer:" + id, "translating", {
          scope: "upstream",
          detail: "回答",
        });
        return translate(value, "en", undefined, context);
      }
      if (Array.isArray(value)) return Promise.all(value.map(convert));
      if (value && typeof value === "object")
        return Object.fromEntries(
          await Promise.all(
            Object.entries(value).map(async ([k, v]) => [k, await convert(v)]),
          ),
        );
      return value;
    };
    try {
      if (reply.updatedInput?.answers)
        reply.updatedInput.answers = await convert(reply.updatedInput.answers);
      if (reply.content) reply.content = await convert(reply.content);
      if (reply.result) reply.result = await convert(reply.result);
      if (reply.message) reply.message = await convert(reply.message);
      if (this.questions.get(id) !== pending) throw fail("交互请求已结束", 404);
      pending.finish(reply);
    } finally {
      this.store.activities.clear(sessionId, "answer:" + id);
    }
  }
  async start(review: Review, options: RunOptions): Promise<Run> {
    const repo = this.store.session(review.sessionId)?.repo;
    if (!repo) throw fail("会话不存在", 404);
    const activityId = "dispatch:" + review.id;
    this.store.activities.set(review.sessionId, activityId, "queued", {
      scope: "upstream",
      detail: review.steering ? "插话" : undefined,
    });
    const previous = this.dispatches.get(repo) || Promise.resolve();
    const dispatch = previous
      .catch(() => {})
      .then(async () => {
        this.reservations.set(repo, review.sessionId);
        try {
          this.store.activities.set(review.sessionId, activityId, "preparing", {
            scope: "upstream",
            detail: review.attachments?.length ? "沙箱与附件" : "沙箱",
          });
          return await this.startInternal(review, options);
        } finally {
          this.reservations.delete(repo);
        }
      });
    this.dispatches.set(repo, dispatch);
    try {
      return await dispatch;
    } finally {
      this.store.activities.clear(review.sessionId, activityId);
      if (this.dispatches.get(repo) === dispatch) this.dispatches.delete(repo);
    }
  }
  private async startInternal(
    review: Review,
    options: RunOptions,
  ): Promise<Run> {
    if (review.status !== "prepared" || !review.english)
      throw fail("请先完成翻译与审阅");
    if (!config.translateUrl && review.mode !== "direct")
      throw fail("尚未配置翻译服务");
    const current = this.connections.get(review.sessionId);
    if (current?.run && !current.run.done && !review.steering)
      throw fail("会话正在执行，请使用插话发送", 409);
    const hasNewEnv = review.findings.some((f) => f.strategy === "env");
    if (hasNewEnv && current?.run && !current.run.done)
      throw fail("插话中不能新增进程 ENV；请使用占位符或等待本轮完成。");
    this.store.bind(review.sessionId, review.findings);
    if (hasNewEnv && current) await this.close(review.sessionId);
    const c = await this.open(
      review.sessionId,
      options.permissionMode === "bypassPermissions",
    );
    c.session.downstreamMode =
      options.downstreamMode || c.session.downstreamMode || "messages";
    this.store.save(c.session);
    const content = await this.media.messageContent(
      review.sessionId,
      review.english,
      review.attachments,
      review.attachmentVersions,
    );
    this.store.activities.set(
      review.sessionId,
      "dispatch:" + review.id,
      "sending",
      { scope: "upstream", detail: review.steering ? "插话" : undefined },
    );
    if (c.run && !c.run.done) {
      const uuid = randomUUID();
      const message = this.store.add(review.sessionId, {
        role: "user",
        original: review.english,
        chinese: review.original,
        kind: "steering",
        sdkUuid: uuid,
        attachments: review.attachments,
        runId: c.run.id,
      });
      c.run.generation++;
      (c.run.pendingSteering ||= new Set()).add(uuid);
      this.emit(c.run, { type: "user", text: "插话已排队", data: message });
      c.input.push({
        type: "user",
        uuid,
        message: { role: "user", content },
        parent_tool_use_id: null,
        priority: "next",
      });
      review.status = "running";
      return c.run;
    }
    const selected = c.capabilities!.models.find(
      (m) => m.value === options.model || m.resolvedModel === options.model,
    );
    if (!selected) throw fail("模型不在当前账号的实时可用目录中，请刷新。");
    if (
      options.effort !== "default" &&
      options.effort !== "off" &&
      !selected.supportedEffortLevels?.includes(options.effort as never)
    )
      throw fail("当前模型不支持所选思考强度");
    const mode =
      options.permissionMode === "auto" && !selected.supportsAutoMode
        ? "default"
        : options.permissionMode;
    await this.bounded(c.q.setModel(options.model));
    await this.bounded(c.q.setPermissionMode(mode));
    await this.bounded(
      c.q.setMaxThinkingTokens(options.effort === "off" ? 0 : null),
    );
    if (options.effort !== "off")
      await this.bounded(
        c.q.applyFlagSettings({
          effortLevel: options.effort === "default" ? null : options.effort,
        }),
      );
    c.session.model = options.model;
    c.session.permissionMode = mode;
    c.session.effort = options.effort;
    if (["新的构思", "新会话"].includes(c.session.title))
      c.session.title = review.original.slice(0, 24).replace(/\n/g, " ");
    this.store.save(c.session);
    const run: Run = {
      id: randomUUID(),
      sessionId: review.sessionId,
      repo: c.session.repo,
      events: [],
      listeners: new Set(),
      done: false,
      output: "",
      streamed: false,
      generation: 1,
      startedAt: Date.now(),
      interrupted: false,
      pendingTools: new Map(),
      blockKinds: new Map(),
    };
    c.run = run;
    c.lastUsed = Date.now();
    this.runs.set(run.id, run);
    review.status = "running";
    const uuid = randomUUID();
    this.store.add(review.sessionId, {
      role: "user",
      original: review.english,
      chinese: review.original,
      sdkUuid: uuid,
      attachments: review.attachments,
      runId: run.id,
    });
    this.phase(c, "waiting_model");
    c.input.push({
      type: "user",
      uuid,
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return run;
  }
  private async consume(c: Connection) {
    try {
      for await (const message of c.q) {
        c.lastUsed = Date.now();
        await this.receive(c, message);
      }
    } catch (error) {
      if (c.run && !c.run.done)
        this.finish(
          c,
          "error",
          error instanceof Error ? error.message : "SDK 连接中断",
        );
    } finally {
      c.closed = true;
      if (c.run && !c.run.done) this.finish(c, "error", "SDK 连接已关闭");
      if (this.connections.get(c.session.id) === c)
        this.connections.delete(c.session.id);
    }
  }
  private record(
    c: Connection,
    kind: TraceBlock["kind"],
    title: string,
    original: string,
    extra: Partial<TraceBlock> = {},
  ) {
    const run = c.run!;
    const block: TraceBlock = {
      id: randomUUID(),
      sessionId: c.session.id,
      runId: run.id,
      createdAt: new Date().toISOString(),
      kind,
      title,
      original,
      translationState: "none",
      ...extra,
    };
    this.store.saveBlock(block);
    this.translations.schedule(block);
    return block;
  }
  private phase(c: Connection, phase: ActivityPhase, detail?: string) {
    const run = c.run;
    if (!run || run.done) return;
    if (
      phase !== "waiting_user" &&
      phase !== "interrupting" &&
      [...this.questions.values()].some((question) => question.runId === run.id)
    )
      return;
    const id = "run:" + run.id;
    if (
      this.store.activities.set(run.sessionId, id, phase, {
        scope: "run",
        detail,
        runId: run.id,
      })
    ) {
      const activity = this.store.activities
        .list(run.sessionId)
        .find((a) => a.id === id)!;
      this.emit(run, {
        type: "status",
        text: activityLabel(activity),
        data: { activity },
      });
    }
  }
  private waitForWork(c: Connection) {
    const names = [...new Set(c.run?.pendingTools?.values() || [])];
    this.phase(
      c,
      names.length ? "waiting_tool" : "waiting_model",
      names.length
        ? names.slice(0, 3).join("、") +
            (names.length > 3 ? ` 等 ${names.length} 项` : "")
        : undefined,
    );
  }
  private async receive(c: Connection, msg: SDKMessage) {
    if (msg.type === "system" && msg.subtype === "init") {
      c.session = {
        ...this.store.session(c.session.id)!,
        sdkSessionId: msg.session_id,
      };
      this.store.save(c.session);
      if (c.capabilities)
        Object.assign(c.capabilities, {
          version: msg.claude_code_version,
          tools: msg.tools,
          updatedAt: new Date().toISOString(),
        });
    }
    const run = c.run;
    if (!run || run.done) return;
    const parent =
      "parent_tool_use_id" in msg
        ? msg.parent_tool_use_id || undefined
        : undefined;
    if (msg.type === "tool_progress") {
      if (
        run.pendingTools?.has(msg.tool_use_id) ||
        (msg.parent_tool_use_id &&
          run.pendingTools?.has(msg.parent_tool_use_id))
      )
        this.waitForWork(c);
      return;
    }
    if (msg.type === "tool_use_summary") {
      const toolIds = Array.isArray(msg.preceding_tool_use_ids)
        ? msg.preceding_tool_use_ids
        : [];
      this.systemProgress(
        c,
        msg.summary,
        { type: msg.type, toolIds },
        toolIds.length === 1 ? toolIds[0] : undefined,
        parent,
      );
      return;
    }
    if (msg.type === "system") {
      if ("task_id" in msg && "tool_use_id" in msg && msg.tool_use_id)
        (run.taskTools ||= new Map()).set(msg.task_id, msg.tool_use_id);
      if (msg.subtype === "thinking_tokens") {
        this.phase(
          c,
          "thinking",
          msg.estimated_tokens > 0
            ? `约 ${Math.round(msg.estimated_tokens).toLocaleString()} token`
            : undefined,
        );
        return;
      }
      if (msg.subtype === "api_retry") {
        this.phase(c, "retrying", `第 ${msg.attempt}/${msg.max_retries} 次`);
        return;
      }
      if (msg.subtype === "status") {
        if (msg.status === "compacting") this.phase(c, "compacting");
        else if (msg.status === "requesting" || msg.status === null)
          this.waitForWork(c);
      }
      if (
        msg.subtype === "session_state_changed" &&
        msg.state === "requires_action"
      )
        this.phase(c, "waiting_user");
    }
    if (msg.type === "stream_event" && !parent) {
      if (msg.event.type === "message_start") {
        run.output = "";
        run.streamed = false;
        run.blockKinds?.clear();
        run.streamSample = {};
        this.waitForWork(c);
      }
      const sample = run.streamSample;
      if (sample && msg.event.type === "content_block_delta") {
        sample.last = performance.now();
        sample.first ??= sample.last;
      }
      if (sample && msg.event.type === "message_delta")
        sample.tokens = msg.event.usage?.output_tokens ?? undefined;
      if (sample && msg.event.type === "message_stop") {
        run.streamSample = undefined;
        const ms = (sample.last ?? 0) - (sample.first ?? 0);
        // Exclude missing or batched streams that have no meaningful decode window.
        if (
          ms >= 200 &&
          sample.tokens &&
          Number.isSafeInteger(sample.tokens) &&
          sample.tokens > 0
        ) {
          const totals = (run.streamTotals ||= { ms: 0, tokens: 0 });
          totals.ms += ms;
          totals.tokens += sample.tokens;
        }
      }
      if (msg.event.type === "content_block_start") {
        const block = msg.event.content_block;
        (run.blockKinds ||= new Map()).set(msg.event.index, block.type);
        if (block.type === "thinking" || block.type === "redacted_thinking")
          this.phase(c, "thinking");
        else if (block.type === "tool_use")
          this.phase(c, "receiving", "工具参数");
        else if (block.type === "text") this.phase(c, "receiving");
      }
      if (
        msg.event.type === "content_block_delta" &&
        msg.event.delta.type === "thinking_delta"
      )
        this.phase(c, "thinking");
      if (
        msg.event.type === "content_block_stop" &&
        ["thinking", "redacted_thinking"].includes(
          run.blockKinds?.get(msg.event.index) || "",
        )
      )
        this.waitForWork(c);
      if (
        msg.event.type === "content_block_delta" &&
        msg.event.delta.type === "text_delta"
      ) {
        this.phase(c, "receiving");
        run.output += msg.event.delta.text;
        run.streamed = true;
        this.emit(run, { type: "original", text: msg.event.delta.text });
        this.store.notify(c.session.id, {
          live: { runId: run.id, delta: msg.event.delta.text },
        });
      }
    }
    if (msg.type === "assistant") {
      const text = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      const calls = msg.message.content.filter((b) => b.type === "tool_use");
      if (text) {
        const block = this.record(
          c,
          calls.length ? "tool_description" : "commentary",
          parent
            ? "子代理输出"
            : calls.length
              ? "工具调用说明"
              : "Claude Code 输出",
          text,
          { parentToolId: parent },
        );
        if (!parent) {
          run.lastBlockId = block.id;
          run.output = calls.length ? "" : text;
        }
      }
      for (const block of msg.message.content) {
        if (block.type === "thinking" && !parent) this.phase(c, "thinking");
        if (block.type === "thinking" && block.thinking)
          this.record(c, "thinking", "思考", block.thinking, {
            parentToolId: parent,
          });
        if (block.type === "tool_use") {
          const input = block.input as { command?: unknown };
          (run.tools ||= new Map()).set(block.id, {
            name: block.name,
            command:
              typeof input.command === "string" ? input.command : undefined,
          });
          if (!parent)
            (run.pendingTools ||= new Map()).set(block.id, block.name);
          this.record(
            c,
            "tool",
            block.name,
            `Claude Code calls the ${block.name} tool.\n\nParameters:\n\x60\x60\x60json\n${JSON.stringify(block.input, null, 2)}\n\x60\x60\x60`,
            {
              toolId: block.id,
              parentToolId: parent,
              data: { name: block.name, input: block.input },
            },
          );
          this.emit(run, {
            type: "tool",
            text: block.name,
            data: { id: block.id, name: block.name, input: block.input },
          });
        }
      }
      if (!parent) {
        if (run.pendingTools?.size) this.waitForWork(c);
        else if (text) this.phase(c, "receiving");
        run.streamed = false;
        this.store.notify(c.session.id, { live: { runId: run.id, text: "" } });
      }
      return;
    }
    if (msg.type === "user") {
      if (Array.isArray(msg.message.content))
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          run.pendingTools?.delete(block.tool_use_id);
          if (!parent) this.waitForWork(c);
          let text = "";
          const images: string[] = [];
          const call = this.store
            .blocks(c.session.id)
            .find((b) => b.kind === "tool" && b.toolId === block.tool_use_id);
          const input =
            (call?.data as { input?: Record<string, unknown> } | undefined)
              ?.input || {};
          // Read may resize an uploaded image. Preserve its provenance even
          // when the tool's returned bytes no longer match the upload hash.
          const uploadedImage = this.store
            .assets(c.session.id)
            .find(
              (a) =>
                a.origin === "upload" &&
                a.kind === "image" &&
                a.sandboxPath &&
                Object.values(input).some(
                  (v) => v === a.sandboxPath || v === a.sandboxPath!.slice(6),
                ),
            );
          if (typeof block.content === "string") text = block.content;
          else if (Array.isArray(block.content))
            for (const content of block.content) {
              if (content.type === "text")
                text += (text ? "\n" : "") + content.text;
              if (
                content.type === "image" &&
                content.source.type === "base64" &&
                content.source.data.length < 36 * 1024 * 1024
              ) {
                if (uploadedImage) {
                  images.push(uploadedImage.id);
                  continue;
                }
                try {
                  images.push(
                    this.media.outputImage(
                      c.session.id,
                      run.id,
                      Buffer.from(content.source.data, "base64"),
                      content.source.media_type,
                    ).id,
                  );
                } catch {}
              }
            }
          this.record(
            c,
            "tool_result",
            block.is_error ? "工具执行失败" : "工具结果",
            text || "Image result",
            {
              toolId: block.tool_use_id,
              parentToolId: parent,
              data: { isError: !!block.is_error, images },
            },
          );
        }
      return;
    }
    if (msg.type === "system" && msg.subtype === "local_command_output") {
      const text = String((msg as any).content || "");
      if (text) {
        this.record(c, "commentary", "命令输出", text);
        run.output = text;
      }
    }
    if (msg.type === "result") {
      const generation = run.generation;
      const sampled = run.streamTotals;
      run.streamTotals = undefined;
      run.streamSample = undefined;
      c.session = {
        ...this.store.session(c.session.id)!,
        usage: mergeUsage(this.store.session(c.session.id)?.usage, {
          total_cost_usd: msg.total_cost_usd,
          model_usage: msg.modelUsage,
          usage: msg.usage,
          num_turns: msg.num_turns,
          last_result: {
            durationMs: msg.duration_ms,
            apiMs: msg.duration_api_ms,
            tps: sampled ? (1000 * sampled.tokens) / sampled.ms : undefined,
          },
        }),
      };
      this.store.save(c.session);
      this.emit(run, { type: "usage", data: c.session.usage });
      const output = (
        "result" in msg && msg.result ? msg.result : run.output
      ).trim();
      run.output = "";
      this.store.notify(c.session.id, { live: { runId: run.id, text: "" } });
      if (output) {
        let block = run.lastBlockId
          ? this.store.block(run.lastBlockId)
          : undefined;
        if (
          !block ||
          block.original.trim() !== output ||
          block.kind === "tool_description"
        ) {
          block = {
            id: randomUUID(),
            sessionId: c.session.id,
            runId: run.id,
            createdAt: new Date().toISOString(),
            kind: "final",
            title: "Claude Code",
            original: output,
            translationState: "none",
          };
        } else block.kind = "final";
        const message = this.store.add(c.session.id, {
          role: "assistant",
          original: output,
          chinese: block.chinese || "",
          runId: run.id,
          blockId: block.id,
        });
        block.messageId = message.id;
        this.store.saveBlock(block);
        this.translations.schedule(block);
        this.emit(run, {
          type: "translation",
          text: block.chinese || "",
          data: { message },
        });
      }
      const consumed =
        msg.user_message_uuids ||
        (msg.user_message_uuid ? [msg.user_message_uuid] : undefined);
      if (consumed)
        for (const uuid of consumed) run.pendingSteering?.delete(uuid);
      // Older CLI producers do not echo client UUIDs. Their queue counter remains the fallback.
      else if ((msg.queued_turn_count || 0) === 0) run.pendingSteering?.clear();
      if (msg.subtype !== "success" || msg.is_error) {
        this.finish(
          c,
          run.interrupted ? "done" : "error",
          run.interrupted
            ? "已中断"
            : "errors" in msg
              ? msg.errors.join("\n")
              : "Claude Code 返回执行错误",
        );
        return;
      }
      if (
        (msg.queued_turn_count || 0) === 0 &&
        !run.pendingSteering?.size &&
        generation === run.generation
      )
        this.finish(c, "done", run.interrupted ? "已中断" : "完成");
      else this.waitForWork(c);
      return;
    }
    if (
      msg.type === "system" &&
      msg.subtype !== "init" &&
      msg.subtype !== "local_command_output"
    ) {
      const value = msg as any;
      const text =
        typeof value.text === "string"
          ? value.text
          : typeof value.summary === "string"
            ? value.summary
            : typeof value.description === "string"
              ? value.description
              : "";
      if (text)
        this.systemProgress(
          c,
          text,
          {
            type: msg.type,
            subtype: msg.subtype,
            taskId: value.task_id,
            status: value.status,
          },
          value.tool_use_id || run.taskTools?.get(value.task_id),
          parent,
        );
      const kind = String(msg.subtype);
      this.emit(run, {
        type: /task|background/.test(kind) ? "task" : "notification",
        text: kind,
        data: msg,
      });
    }
  }
  private systemProgress(
    c: Connection,
    text: string,
    data: Record<string, unknown>,
    toolId?: string,
    parentToolId?: string,
  ) {
    if (!text) return;
    const run = c.run!;
    if (!toolId) {
      for (const [id, tool] of run.tools || [])
        if (tool.name === "Bash" && tool.command?.trim() === text.trim())
          toolId = id;
    }
    const tool = toolId ? run.tools?.get(toolId) : undefined;
    const code = tool?.name === "Bash" && tool.command?.trim() === text.trim();
    this.record(c, "tool_progress", "执行进度", text, {
      toolId,
      parentToolId,
      data: {
        source: "sdk_system",
        ...data,
        ...(code ? { format: "code", language: "bash" } : {}),
      },
    });
  }
  private finish(c: Connection, type: "done" | "error", text: string) {
    const run = c.run;
    if (!run || run.done) return;
    run.done = true;
    this.store.activities.clear(run.sessionId, "run:" + run.id);
    if (run.output.trim()) {
      const block = this.record(c, "final", "未完成的回复", run.output);
      const message = this.store.add(c.session.id, {
        role: "assistant",
        original: run.output,
        chinese: "",
        runId: run.id,
        blockId: block.id,
      });
      block.messageId = message.id;
      this.store.saveBlock(block);
      run.output = "";
    }
    this.emit(run, {
      type,
      text: text.replace(/(?:sk-ant-|ccsb_)[\w-]+/g, "[credential]"),
    });
    for (const pending of this.questions.values())
      if (pending.runId === run.id) pending.finish({ allow: false });
    c.lastUsed = Date.now();
  }
  async interrupt(id: string) {
    const run = this.runs.get(id);
    if (!run) throw fail("任务不存在", 404);
    const c = this.connections.get(run.sessionId);
    if (!c || run.done) return { ok: true };
    run.interrupted = true;
    this.phase(c, "interrupting");
    return this.bounded(c.q.interrupt());
  }
  async control(
    id: string,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (!controls.some((c) => c.method === method))
      throw fail("SDK 控制方法不存在", 404);
    if (method === "streamInput")
      throw fail("请通过输入框发送插话，以完成隐私检查与翻译。");
    if (method === "close") {
      await this.close(id);
      return { ok: true };
    }
    const c = await this.open(id);
    c.lastUsed = Date.now();
    if (method === "reinitialize" && c.run && !c.run.done)
      throw fail("执行期间请勿重新初始化，以免取消待确认的工具请求。", 409);
    if (
      method === "setPermissionMode" &&
      args[0] === "bypassPermissions" &&
      !c.bypass
    )
      throw fail(
        "请在输入框旁选择完全放行，再开始下一轮。当前连接没有开启此权限。",
      );
    const actual = method === "usage" ? usageMethod : method;
    const fn = (c.q as unknown as Record<string, unknown>)[actual];
    if (typeof fn !== "function") throw fail("当前 SDK 未提供此功能", 501);
    try {
      if (
        method === "applyFlagSettings" &&
        args[0] &&
        typeof args[0] === "object" &&
        "effortLevel" in args[0]
      )
        await this.bounded(c.q.setMaxThinkingTokens(null));
      const result = await this.bounded(Reflect.apply(fn, c.q, args));
      if (method === "setModel")
        c.session.model = typeof args[0] === "string" ? args[0] : "default";
      if (method === "setPermissionMode")
        c.session.permissionMode = args[0] as PermissionMode;
      if (method === "setMaxThinkingTokens" && args[0] === 0)
        c.session.effort = "off";
      if (
        method === "applyFlagSettings" &&
        args[0] &&
        typeof args[0] === "object" &&
        "effortLevel" in args[0]
      )
        c.session.effort =
          (args[0] as { effortLevel?: Effort }).effortLevel || "default";
      if (
        [
          "setModel",
          "setPermissionMode",
          "setMaxThinkingTokens",
          "applyFlagSettings",
        ].includes(method)
      ) {
        c.session.downstreamMode =
          this.store.session(c.session.id)?.downstreamMode ||
          c.session.downstreamMode;
        this.store.save(c.session);
      }
      delete c.capabilities!.unavailable[method];
      if (method === "usage" && result && typeof result === "object") {
        const reported = (result as { session?: Record<string, unknown> })
          .session;
        if (reported) {
          c.session = this.store.session(c.session.id)!;
          c.session.usage = mergeUsage(c.session.usage, reported);
          this.store.save(c.session);
          this.store.notify(c.session.id, { session: c.session });
        }
        return {
          ...result,
          ...(reported ? { session: c.session.usage } : {}),
          authentication_mode: usesWebLogin(c.session.repo) ? "web" : "token",
        };
      }
      return result ?? { ok: true };
    } catch (error) {
      c.capabilities!.unavailable[method] = (error as Error).message;
      throw error;
    }
  }
  async command(
    id: string,
    text: string,
  ): Promise<{ control?: string; args?: unknown[]; prompt?: string }> {
    const [name, ...rest] = text.trim().slice(1).split(/\s+/);
    const value = rest.join(" ");
    const map: Record<string, string> = {
      usage: "usage",
      cost: "usage",
      stats: "usage",
      context: "getContextUsage",
      mcp: "mcpServerStatus",
      agents: "supportedAgents",
      skills: "supportedCommands",
      "reload-skills": "reloadSkills",
      "reload-plugins": "reloadPlugins",
      account: "accountInfo",
      status: "initializationResult",
      permissions: "initializationResult",
      tasks: "initializationResult",
    };
    if (name === "model")
      return value
        ? { control: "setModel", args: [value] }
        : { control: "supportedModels" };
    if (name === "effort")
      return {
        control: "applyFlagSettings",
        args: [{ effortLevel: value || null }],
      };
    if (name === "clear" || name === "new" || name === "reset")
      return { control: "clear" };
    if (map[name])
      return {
        control: map[name],
        args:
          name === "context"
            ? [{ detail: "summary" }]
            : name === "usage" || name === "cost" || name === "stats"
              ? [{ skipBehaviors: true }]
              : [],
      };
    const caps = await this.capabilities(id);
    const exists = caps.commands.some(
      (c) => c.name === name || c.aliases?.includes(name),
    );
    if (!exists) throw fail("当前 Claude Code 未提供此命令");
    return { prompt: text };
  }
  async close(id: string) {
    const c = this.connections.get(id);
    if (!c) return;
    c.input.close();
    c.controller.abort();
    c.q.close();
    c.closed = true;
    if (c.run && !c.run.done)
      this.finish(c, "error", "SDK 连接已关闭，已保留会话");
    this.connections.delete(id);
    await c.drain;
  }
  async closeRepo(repo: string) {
    for (const c of [...this.connections.values()])
      if (c.session.repo === repo) await this.close(c.session.id);
  }
  async housekeep() {
    for (const c of this.connections.values())
      if ((!c.run || c.run.done) && Date.now() - c.lastUsed > 180000)
        await this.close(c.session.id);
    for (const [id, run] of this.runs)
      if (
        run.done &&
        run.listeners.size === 0 &&
        Date.now() - run.startedAt > 3600000
      )
        this.runs.delete(id);
  }
  async shutdown() {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)));
    await Promise.all([this.translations.shutdown(), this.media.shutdown()]);
  }
}
