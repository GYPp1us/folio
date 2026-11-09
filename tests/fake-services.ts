import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
function frame(stream: number, value: Buffer | string) {
  const body = typeof value === "string" ? Buffer.from(value) : value;
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
export async function fakeServices(
  options: {
    steeringInterrupt?: boolean;
    trace?: boolean;
    latencyMs?: number;
    tracePauseMs?: number;
    streamChunks?: string[];
    streamPauseMs?: number;
    reply?: string | ((message: Record<string, any>) => string);
    requiresWebLoginForUsage?: boolean;
  } = {},
) {
  const translations: Record<string, any>[] = [],
    inputs: Record<string, any>[] = [],
    headers: Record<string, any>[] = [],
    controls: Record<string, any>[] = [];
  const files = new Map<string, Buffer>();
  const webLogins = new Set<string>(),
    loginCodes: string[] = [];
  const models = [
    {
      value: "default",
      displayName: "Test model",
      resolvedModel: "test-model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
      supportsAutoMode: true,
    },
    { value: "fast", displayName: "Test fast", supportsEffort: false },
  ];
  const commands = [
    { name: "usage", description: "Usage", argumentHint: "", builtin: true },
    {
      name: "compact",
      description: "Compact context",
      argumentHint: "",
      builtin: true,
    },
    {
      name: "inspect",
      description: "Inspect files",
      argumentHint: "<path>",
      builtin: false,
    },
  ];
  const init = {
    models,
    commands,
    agents: [],
    available_output_styles: ["default"],
    output_style: "default",
    account: {
      email: "test@example.invalid",
      tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
    },
  };
  const server = createServer((req, res) => {
    const url = req.url || "";
    if (url === "/chat/completions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const request = JSON.parse(body);
        translations.push(request);
        const content = request.messages[1].content;
        const plain = Array.isArray(content)
          ? content.find((c: any) => c.type === "text").text
          : content;
        let payload: any;
        try {
          payload = JSON.parse(plain);
        } catch {
          payload = { current_message: plain };
        }
        const value = payload.current_message;
        const toEnglish = request.messages[0].content.includes("English");
        let output =
          payload.current_kind === "page_catalog"
            ? JSON.stringify(
                Object.fromEntries(
                  Object.entries(JSON.parse(value)).map(([k, v]) => [
                    k,
                    "中文：" + v,
                  ]),
                ),
              )
            : payload.current_kind === "output_image"
              ? JSON.stringify({
                  description_en: "A diagram with a Start label",
                  description_zh: "流程图，Start：开始",
                })
              : toEnglish
                ? value.replace(/[\p{Script=Han}，。；：]+/gu, " translated ")
                : "已完成：" + value;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: output } }],
            usage: { completion_tokens_details: { reasoning_tokens: 0 } },
          }),
        );
      });
      return;
    }
    if (url === "/sandbox/exec") {
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.flushHeaders();
      const args = JSON.parse(String(req.headers["x-ccsb-args"] || "[]"));
      const env = JSON.parse(String(req.headers["x-ccsb-env"] || "{}"));
      const repo = String(req.headers["x-ccsb-repo"]);
      if (
        args[0] === "-c" &&
        /^# folio-safe-(?:read|write)-v1/.test(args[1] || "")
      ) {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
          const key = repo + ":" + args[2];
          const exit = Buffer.alloc(4);
          if (args[1].startsWith("# folio-safe-write"))
            files.set(key, Buffer.concat(chunks));
          else if (files.has(key)) res.write(frame(1, files.get(key)!));
          else exit.writeInt32BE(1);
          res.end(frame(3, exit));
        });
        return;
      }
      if (
        env.FOLIO_AUTH_FLOW_ID &&
        args[1] === "exec claude auth login --claudeai"
      ) {
        res.write(
          frame(
            1,
            "Open https://claude.com/cai/oauth/authorize?client_id=test&state=test-state&code_challenge=test-challenge&scope=user%3Aprofile%20user%3Ainference\n",
          ),
        );
        let input = "";
        req.on("data", (chunk) => {
          input += chunk.toString();
          if (!input.includes("\n") || res.writableEnded) return;
          loginCodes.push(input.trim());
          const valid = input.trim() === "one-time-code-for-test";
          if (valid) webLogins.add(repo);
          res.write(
            frame(
              1,
              valid ? "Login successful.\n" : "Authentication failed.\n",
            ),
          );
          const exit = Buffer.alloc(4);
          exit.writeInt32BE(valid ? 0 : 1);
          res.end(frame(3, exit));
        });
        return;
      }
      if (args[0] === "auth") {
        res.write(
          frame(
            1,
            JSON.stringify({
              loggedIn: !!env.CLAUDE_CODE_OAUTH_TOKEN || webLogins.has(repo),
              authMethod: env.CLAUDE_CODE_OAUTH_TOKEN
                ? "oauth_token"
                : webLogins.has(repo)
                  ? "claude.ai"
                  : "none",
            }),
          ),
        );
        res.end(frame(3, Buffer.alloc(4)));
        req.resume();
        return;
      }
      let turns = 0;
      const modelUsage = () => ({
        "test-model": {
          inputTokens: turns * 3,
          outputTokens: turns * 5,
          cacheReadInputTokens: turns * 7,
          cacheCreationInputTokens: turns * 11,
          costUSD: 0.001,
          webSearchRequests: 0,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      });
      let buffer = "",
        busy = false;
      const pending: Record<string, any>[] = [];
      const sessionId = randomUUID();
      let timer: ReturnType<typeof setTimeout>;
      const send = (value: unknown) => {
        if (!res.destroyed) res.write(frame(1, JSON.stringify(value) + "\n"));
      };
      function next() {
        if (busy || !pending.length) return;
        busy = true;
        const user = pending.shift()!;
        send({
          type: "system",
          subtype: "init",
          session_id: sessionId,
          uuid: randomUUID(),
          claude_code_version: "test-cli",
          cwd: "/work",
          tools: ["Read", "Bash"],
          mcp_servers: [],
          model: "test-model",
          permissionMode: "auto",
          slash_commands: commands.map((c) => c.name),
          output_style: "default",
          skills: [],
          plugins: [],
          apiKeySource: "none",
        });
        timer = setTimeout(async () => {
          turns++;
          const reply =
            (typeof options.reply === "function"
              ? options.reply(user)
              : options.reply) || "Completed.";
          if (options.trace) {
            const image = Array.isArray(user.message.content)
              ? user.message.content.find((b: any) => b.type === "image")
              : undefined;
            const attachedPath = image
              ? user.message.content[0].text.match(
                  /\/work\/\.folio\/inputs\/[^`\s]+/,
                )?.[0]
              : undefined;
            send({
              type: "assistant",
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                id: randomUUID(),
                type: "message",
                role: "assistant",
                model: "test-model",
                content: [
                  { type: "text", text: "I will read the file." },
                  {
                    type: "tool_use",
                    id: "read-file-1",
                    name: "Read",
                    input: { file_path: attachedPath || "/work/example.txt" },
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 2 },
              },
            });
            if (options.tracePauseMs)
              await new Promise((resolve) =>
                setTimeout(resolve, options.tracePauseMs),
              );
            if (res.destroyed || res.writableEnded || !busy) return;
            send({
              type: "user",
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read-file-1",
                    content: image
                      ? [
                          { type: "text", text: "Read an uploaded image." },
                          {
                            type: "image",
                            source: {
                              ...image.source,
                              data: Buffer.concat([
                                Buffer.from(image.source.data, "base64"),
                                Buffer.from("resized-by-tool"),
                              ]).toString("base64"),
                            },
                          },
                        ]
                      : "File has three lines.",
                  },
                ],
              },
            });
            send({
              type: "assistant",
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              message: {
                id: randomUUID(),
                type: "message",
                role: "assistant",
                model: "test-model",
                content: [{ type: "text", text: "The file looks good." }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 2 },
              },
            });
          }
          for (const delta of options.streamChunks || [reply]) {
            send({
              type: "stream_event",
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: delta },
              },
            });
            if (options.streamPauseMs)
              await new Promise((resolve) =>
                setTimeout(resolve, options.streamPauseMs),
              );
            if (res.destroyed || res.writableEnded || !busy) return;
          }
          send({
            type: "assistant",
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              id: randomUUID(),
              type: "message",
              role: "assistant",
              model: "test-model",
              content: [{ type: "text", text: reply }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 3 },
            },
          });
          send({
            type: "result",
            subtype: "success",
            is_error: false,
            result: reply,
            duration_ms: 800,
            duration_api_ms: 10,
            num_turns: 1,
            total_cost_usd: 0.001,
            usage: {
              input_tokens: 3,
              output_tokens: 3,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            modelUsage: modelUsage(),
            permission_denials: [],
            uuid: randomUUID(),
            session_id: sessionId,
            queued_turn_count: pending.length,
            user_message_uuid: user.uuid,
          });
          busy = false;
          next();
        }, options.latencyMs ?? 800);
      }
      req.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.type === "control_request") {
            const request = message.request;
            controls.push(request);
            const type = request.subtype;
            let response: unknown = {};
            if (type === "initialize") response = init;
            else if (type === "get_usage")
              response = {
                session: {
                  total_cost_usd: 0.001,
                  total_api_duration_ms: 10,
                  total_lines_added: 0,
                  total_lines_removed: 0,
                  model_usage: modelUsage(),
                },
                subscription_type: "test",
                rate_limits_available: true,
                rate_limits: {
                  five_hour: {
                    utilization: 20,
                    resets_at: "2026-10-28T00:00:00Z",
                  },
                },
              };
            if (type === "get_usage" && options.requiresWebLoginForUsage) {
              const available =
                webLogins.has(repo) && !env.CLAUDE_CODE_OAUTH_TOKEN;
              Object.assign(response as object, {
                rate_limits_available: available,
                rate_limits: available
                  ? {
                      limits: [
                        {
                          kind: "session",
                          group: "session",
                          percent: 23,
                          resets_at: "2026-10-28T12:00:00Z",
                          severity: "normal",
                          is_active: true,
                        },
                      ],
                      extra_usage: null,
                    }
                  : null,
              });
            } else if (type === "get_context_usage")
              response = {
                totalTokens: 100,
                maxTokens: 1000,
                percentage: 10,
                categories: [],
              };
            else if (type === "mcp_status") response = { mcpServers: [] };
            else if (type === "rewind_files")
              response = { canRewind: true, filesChanged: ["README.md"] };
            else if (type === "interrupt") {
              clearTimeout(timer);
              pending.length = 0;
              busy = false;
              send({
                type: "result",
                subtype: "success",
                is_error: false,
                result: "Interrupted.",
                total_cost_usd: 0,
                usage: {},
                modelUsage: {},
                queued_turn_count: 0,
                uuid: randomUUID(),
                session_id: sessionId,
              });
            }
            send({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response,
              },
            });
          } else if (message.type === "user") {
            inputs.push(message);
            if (options.steeringInterrupt && message.priority === "now") {
              clearTimeout(timer);
              pending.length = 0;
              busy = false;
              send({
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                errors: [
                  "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
                ],
                total_cost_usd: 0,
                usage: {},
                modelUsage: {},
                queued_turn_count: 0,
                uuid: randomUUID(),
                session_id: sessionId,
              });
              continue;
            }
            pending.push(message);
            next();
          }
        }
      });
      res.on("close", () => clearTimeout(timer));
      req.on("end", () => {
        if (!res.destroyed) res.end(frame(3, Buffer.alloc(4)));
      });
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/sandbox/status"))
      res.end(JSON.stringify({ running: true, exists: true }));
    else if (url === "/sandbox/image/status")
      res.end(JSON.stringify({ version: "test-cli", image: "test" }));
    else if (url === "/volumes") res.end(JSON.stringify({ volumes: [] }));
    else res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    translations,
    files,
    inputs,
    headers,
    controls,
    webLogins,
    loginCodes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
