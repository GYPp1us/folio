import { useEffect, useRef, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { api, Busy, JsonView, Modal, Picker } from "./ui";
import type { Capabilities, Session } from "../shared/types";
import { planRows, sessionTokens, type SandboxUsage } from "../shared/usage";
type Tab = "usage" | "context" | "extensions" | "tasks" | "files" | "sdk";
export function ControlsPanel({
  open,
  onOpenChange,
  session,
  capabilities,
  initialTab = "usage",
  usageScope = "session",
  initialResult,
  tasks,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session?: Session;
  capabilities?: Capabilities;
  initialTab?: Tab;
  usageScope?: "session" | "sandbox";
  initialResult?: { method: string; result: unknown };
  tasks: unknown[];
  onChanged: (method: string, args: unknown[]) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab),
    [data, setData] = useState<unknown>(),
    [error, setError] = useState(""),
    [pending, setPending] = useState(""),
    [method, setMethod] = useState("usage"),
    [args, setArgs] = useState('[{"skipBehaviors":true}]'),
    [mcp, setMcp] = useState<Record<string, unknown>[]>([]),
    [path, setPath] = useState("README.md"),
    [checkpoint, setCheckpoint] = useState(""),
    [rewind, setRewind] = useState<Record<string, unknown>>();
  const [aggregate, setAggregate] = useState<SandboxUsage>();
  const identity = useRef(session?.id),
    requestId = useRef(0);
  identity.current = session?.id;
  const readUsage = async () => {
    if (!session) return;
    if (usageScope === "session")
      return execute("usage", [{ skipBehaviors: true }]);
    const id = ++requestId.current,
      sessionId = session.id;
    setPending("sandboxUsage");
    setError("");
    try {
      const aggregate = await api<SandboxUsage>(
        `/sandbox/usage?repo=${encodeURIComponent(session.repo)}`,
      );
      if (identity.current === sessionId && requestId.current === id)
        setAggregate(aggregate);
    } catch (error) {
      if (identity.current === sessionId && requestId.current === id)
        setError((error as Error).message);
    } finally {
      if (identity.current === sessionId && requestId.current === id)
        setPending("");
    }
  };
  const execute = async (name: string, parameters: unknown[] = []) => {
    if (!session) return;
    const id = ++requestId.current,
      sessionId = session.id;
    setPending(name);
    setError("");
    try {
      const response = await api<{ result: unknown }>(
        `/sessions/${session.id}/control`,
        { method: name, args: parameters },
      );
      if (identity.current !== sessionId || requestId.current !== id) return;
      setData(response.result);
      if (name === "mcpServerStatus")
        setMcp(Array.isArray(response.result) ? response.result : []);
      if (name === "rewindFiles")
        setRewind(response.result as Record<string, unknown>);
      onChanged(name, parameters);
      return response.result;
    } catch (e) {
      if (identity.current === sessionId && requestId.current === id)
        setError((e as Error).message);
    } finally {
      if (identity.current === sessionId && requestId.current === id)
        setPending("");
    }
  };
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setError("");
      setData(initialResult?.result);
      if (initialResult) {
        setMethod(initialResult.method);
        const selected = capabilities?.controls.find(
          (c) => c.method === initialResult.method,
        );
        setArgs(selected?.args || "[]");
      }
    }
  }, [open, initialTab, initialResult]);
  useEffect(() => {
    if (!open || !session) return;
    if (tab === "usage") void readUsage();
    if (tab === "context")
      void execute("getContextUsage", [{ detail: "summary" }]);
    if (tab === "extensions") void execute("mcpServerStatus");
  }, [open, tab, session?.id, usageScope]);
  const raw = (data || {}) as Record<string, any>,
    usage = raw.session || {},
    rates = raw.rate_limits || {};
  const context = raw.usage || raw;
  const selectedAggregate =
    aggregate?.repo === session?.repo ? aggregate : undefined;
  const tokens =
    usageScope === "sandbox"
      ? selectedAggregate || sessionTokens()
      : sessionTokens(usage, session?.usage);
  const formatTokens = (value: number | null) =>
    value === null ? "—" : value.toLocaleString();
  const descriptors = capabilities?.controls || [];
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="用量与控制"
      description={session?.repo}
      wide
    >
      <div className="tabs">
        {(
          [
            { id: "usage", label: "用量" },
            { id: "context", label: "上下文" },
            { id: "extensions", label: "技能 / MCP" },
            { id: "tasks", label: "任务" },
            { id: "files", label: "文件" },
            { id: "sdk", label: "SDK 控制" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => {
              setTab(t.id);
              setData(undefined);
              setError("");
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {pending && (
        <div className="small-status">
          <Busy />
          读取状态…
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "usage" && (
        <>
          <div className="panel-row">
            <span>
              {usageScope === "sandbox"
                ? `沙箱全部会话 · ${selectedAggregate?.sessionCount ?? "—"} 个会话`
                : "当前会话用量"}
            </span>
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() => void readUsage()}
            >
              <RotateCcw size={13} />
              刷新
            </button>
          </div>
          <div
            className="token-totals"
            aria-label={
              usageScope === "sandbox" ? "沙箱累计 token" : "会话累计 token"
            }
          >
            {(
              [
                {
                  key: "total",
                  label:
                    usageScope === "sandbox" ? "沙箱总 token" : "会话总 token",
                },
                { key: "input", label: "输入（未缓存）" },
                { key: "output", label: "输出" },
                { key: "cacheRead", label: "缓存读取" },
                { key: "cacheWrite", label: "缓存写入" },
              ] as const
            ).map((item) => (
              <div key={item.key}>
                <span>{item.label}</span>
                <strong>{formatTokens(tokens.totals[item.key])}</strong>
              </div>
            ))}
          </div>
          <p className="muted token-note">
            总计 = 输入 + 输出 + 缓存读取 +
            缓存写入，包含子代理。尚未返回的用量显示为 —。
            {usageScope === "sandbox" &&
              " 汇总当前沙箱在 Folio 中保留的所有会话；同一个 SDK 会话不会重复统计。"}
            {!!selectedAggregate?.pendingSessions &&
              usageScope === "sandbox" &&
              ` ${selectedAggregate.pendingSessions} 个会话尚未返回完整用量。`}
          </p>
          {tokens.models.length > 0 && (
            <details className="token-models">
              <summary>逐模型 token</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>输入</th>
                      <th>输出</th>
                      <th>缓存读取</th>
                      <th>缓存写入</th>
                      <th>总计</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.models.map((m) => (
                      <tr key={m.name}>
                        <td>{m.name}</td>
                        <td>{formatTokens(m.input)}</td>
                        <td>{formatTokens(m.output)}</td>
                        <td>{formatTokens(m.cacheRead)}</td>
                        <td>{formatTokens(m.cacheWrite)}</td>
                        <td>{formatTokens(m.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {data !== undefined && usageScope === "session" && (
            <>
              <div className="usage-totals">
                <div>
                  <span>当前会话估算费用</span>
                  <strong>
                    $
                    {Number(
                      usage.total_cost_usd ??
                        session?.usage?.total_cost_usd ??
                        0,
                    ).toFixed(4)}
                  </strong>
                </div>
                <div>
                  <span>模型 API 时间</span>
                  <strong>
                    {(Number(usage.total_api_duration_ms || 0) / 1000).toFixed(
                      1,
                    )}{" "}
                    s
                  </strong>
                </div>
                <div>
                  <span>代码改动</span>
                  <strong>
                    +{usage.total_lines_added || 0} / −
                    {usage.total_lines_removed || 0}
                  </strong>
                </div>
              </div>
              <details className="account-quota-details">
                <summary>账号共享额度</summary>
                {planRows(rates).map((window) => {
                  return (
                    <div className="rate-window" key={window.key}>
                      <div>
                        <span>{window.label}</span>
                        <span>
                          {window.percent == null
                            ? "不可用"
                            : `${window.percent}%`}
                        </span>
                      </div>
                      {window.percent != null && (
                        <progress max={100} value={window.percent} />
                      )}
                      <small>
                        {window.resetsAt
                          ? new Date(window.resetsAt).toLocaleString("zh-CN") +
                            " 重置"
                          : ""}
                      </small>
                    </div>
                  );
                })}
                {(raw.rate_limits_available === false ||
                  raw.rate_limits === null) && (
                  <p className="muted">
                    {raw.authentication_mode === "token"
                      ? "长期 token 无法读取完整套餐用量。请在左侧沙箱管理中完成网页登录。"
                      : "暂未取得套餐用量，可能是上游限流或授权失效，请稍后刷新或重新网页登录。"}
                  </p>
                )}
              </details>
              <details>
                <summary>当前连接原始用量</summary>
                <JsonView value={data} />
              </details>
            </>
          )}
        </>
      )}
      {tab === "context" && data !== undefined && (
        <>
          <div className="usage-totals">
            <div>
              <span>已使用</span>
              <strong>
                {Number(
                  context.total_tokens ??
                    context.usedTokens ??
                    context.totalTokens ??
                    0,
                ).toLocaleString()}
              </strong>
            </div>
            <div>
              <span>窗口</span>
              <strong>
                {Number(
                  context.raw_max_tokens ??
                    context.rawMaxTokens ??
                    context.contextWindow ??
                    context.maxTokens ??
                    0,
                ).toLocaleString()}
              </strong>
            </div>
            <div>
              <span>占用</span>
              <strong>
                {context.percentage ?? context.percentUsed ?? "—"}%
              </strong>
            </div>
          </div>
          <div className="button-row">
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() =>
                void execute("getContextUsage", [{ detail: "full" }])
              }
            >
              完整分类统计
            </button>
          </div>
          <details>
            <summary>上下文明细</summary>
            <JsonView value={data} />
          </details>
        </>
      )}
      {tab === "extensions" && (
        <>
          <h3>MCP</h3>
          {mcp.length ? (
            mcp.map((server) => (
              <div className="mcp-row" key={String(server.name)}>
                <div>
                  <strong>{String(server.name)}</strong>
                  <small>{String(server.status)}</small>
                </div>
                <button
                  className="secondary"
                  disabled={!!pending}
                  onClick={() =>
                    void execute("reconnectMcpServer", [server.name])
                  }
                >
                  重连
                </button>
                <button
                  className="secondary"
                  disabled={!!pending}
                  onClick={() =>
                    void execute("toggleMcpServer", [
                      server.name,
                      server.status === "disabled",
                    ])
                  }
                >
                  {server.status === "disabled" ? "启用" : "停用"}
                </button>
              </div>
            ))
          ) : (
            <p className="muted">未配置 MCP 服务</p>
          )}
          <details>
            <summary>增删 MCP（JSON 配置）</summary>
            <textarea
              className="code-input"
              defaultValue="{}"
              id="mcp-config"
              aria-label="MCP JSON 配置"
            />
            <button
              className="secondary"
              onClick={() => {
                try {
                  const value = JSON.parse(
                    (
                      document.getElementById(
                        "mcp-config",
                      ) as HTMLTextAreaElement
                    ).value,
                  );
                  void execute("setMcpServers", [value]);
                } catch {
                  setError("JSON 格式不正确");
                }
              }}
            >
              应用 MCP 配置
            </button>
          </details>
          <h3>技能与命令</h3>
          <div className="button-row">
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() => void execute("reloadSkills")}
            >
              重载技能
            </button>
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() =>
                void execute("reloadPlugins", [{ holdOnCacheImpact: true }])
              }
            >
              重载插件
            </button>
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() => void execute("reloadOutputStyles")}
            >
              重载输出样式
            </button>
          </div>
          <div className="command-table">
            {capabilities?.commands.map((command) => (
              <div key={command.name}>
                <code>/{command.name}</code>
                <span>{command.description}</span>
              </div>
            ))}
          </div>
          <h3>子代理定义</h3>
          <JsonView value={capabilities?.agents || []} />
        </>
      )}
      {tab === "tasks" && (
        <>
          <div className="panel-row">
            <h3>任务与子代理事件</h3>
            <button
              className="secondary"
              disabled={!!pending}
              onClick={() => void execute("backgroundTasks")}
            >
              当前任务转后台
            </button>
          </div>
          {tasks.length ? (
            tasks.map((task, i) => {
              const value = task as Record<string, unknown>;
              const id = value.task_id || value.id;
              return (
                <details key={i}>
                  <summary>
                    {String(
                      value.description ||
                        value.subtype ||
                        value.type ||
                        "任务事件",
                    )}
                    {Boolean(id) && <code>{String(id)}</code>}
                  </summary>
                  <JsonView value={task} />
                  {typeof id === "string" && (
                    <button
                      className="secondary danger-text"
                      onClick={() => void execute("stopTask", [id])}
                    >
                      停止任务 {id}
                    </button>
                  )}
                </details>
              );
            })
          ) : (
            <p className="muted">尚无任务事件</p>
          )}
        </>
      )}
      {tab === "files" && (
        <>
          <div className="inline-form">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              aria-label="沙箱文件路径"
              placeholder="相对 /work 的文件路径"
            />
            <button
              className="secondary"
              disabled={!!pending || !path}
              onClick={() =>
                void execute("readFile", [path, { maxBytes: 1048576 }])
              }
            >
              读取文件
            </button>
          </div>
          <h3>文件检查点</h3>
          <p className="muted">
            从会话消息旁复制检查点 UUID。先预览，再执行回滚。
          </p>
          <input
            value={checkpoint}
            onChange={(e) => {
              setCheckpoint(e.target.value);
              setRewind(undefined);
            }}
            aria-label="检查点 UUID"
            placeholder="用户消息 UUID"
          />
          <div className="button-row">
            <button
              className="secondary"
              disabled={!checkpoint || !!pending}
              onClick={() =>
                void execute("rewindFiles", [checkpoint, { dryRun: true }])
              }
            >
              预览回滚
            </button>
            <button
              className="secondary danger-text"
              disabled={!rewind?.canRewind || !!pending}
              onClick={() =>
                void execute("rewindFiles", [checkpoint, { dryRun: false }])
              }
            >
              确认回滚文件
            </button>
          </div>
          {data !== undefined && <JsonView value={data} />}
        </>
      )}
      {tab === "sdk" && (
        <>
          <div className="control-select">
            <Picker
              label="SDK 控制方法"
              value={method}
              onChange={(value) => {
                setMethod(value);
                setArgs(
                  descriptors.find((d) => d.method === value)?.args || "[]",
                );
                setData(undefined);
                setError("");
              }}
              options={descriptors.map((d) => ({
                value: d.method,
                label: d.label,
                disabled: d.method === "streamInput",
              }))}
            />
            <button
              className="secondary"
              disabled={!!pending || method === "streamInput"}
              onClick={() => {
                try {
                  const parsed = JSON.parse(args);
                  if (!Array.isArray(parsed)) throw new Error();
                  void execute(method, parsed);
                } catch {
                  setError("参数需要是 JSON 数组");
                }
              }}
            >
              <Play size={13} />
              执行
            </button>
          </div>
          <label className="field">
            参数数组
            <textarea
              className="code-input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              aria-label="SDK 参数数组"
            />
          </label>
          <p className="muted">
            直接调用已安装 SDK 的公开接口。当前 CLI
            未实现的方法会返回真实错误；不会模拟成功。插话使用输入框发送。
          </p>
          {data !== undefined && <JsonView value={data} />}
        </>
      )}
    </Modal>
  );
}
