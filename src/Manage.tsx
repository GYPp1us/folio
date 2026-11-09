import { useEffect, useState } from "react";
import {
  Download,
  Globe2,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
  WifiOff,
} from "lucide-react";
import { api, Busy, JsonView } from "./ui";
import type { PublicConfig } from "../shared/types";
import { SandboxLoginPanel } from "./SandboxLoginPanel";
export function ConnectionForm({
  config,
  onSaved,
}: {
  config: PublicConfig;
  onSaved: (config: PublicConfig) => void;
}) {
  const [url, setUrl] = useState(config.translatorUrl),
    [model, setModel] = useState(config.translator),
    [oauth, setOauth] = useState(""),
    [key, setKey] = useState(""),
    [visionModel, setVisionModel] = useState(config.visionModel || ""),
    [visionUrl, setVisionUrl] = useState(config.visionUrl || ""),
    [visionKey, setVisionKey] = useState(""),
    [protocol, setProtocol] = useState(config.translatorProtocol),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setError("");
        void api<PublicConfig>("/config", {
          oauthToken: oauth,
          translatorUrl: url,
          translatorModel: model,
          translatorKey: key,
          translatorProtocol: protocol,
          visionModel,
          visionUrl,
          visionKey,
        })
          .then(onSaved)
          .catch((e) => setError(e.message))
          .finally(() => setPending(false));
      }}
    >
      <label className="field">
        Claude OAuth token
        <input
          type="password"
          autoComplete="off"
          value={oauth}
          onChange={(e) => setOauth(e.target.value)}
          placeholder={
            config.oauthConfigured ? "已配置，留空保留" : "claude setup-token"
          }
        />
      </label>
      <label className="field">
        翻译接口
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          placeholder="https://provider.example/v1"
        />
      </label>
      <label className="field">
        翻译模型
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
        />
      </label>
      <label className="field">
        翻译 API Key
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="留空保留"
        />
      </label>
      <label className="field">
        关闭翻译思考的接口协议
        <select
          value={protocol}
          onChange={(e) => setProtocol(e.target.value as typeof protocol)}
        >
          <option value="auto">按接口与模型识别</option>
          <option value="off">网关（reasoning_effort: off）</option>
          <option value="openai">OpenAI（reasoning_effort: none）</option>
          <option value="thinking">DeepSeek / GLM（thinking: disabled）</option>
          <option value="qwen">Qwen / Ollama（enable_thinking: false）</option>
        </select>
      </label>
      <details>
        <summary>输出图片翻译</summary>
        <div className="form">
          <label className="field">
            视觉翻译模型
            <input
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
              placeholder="留空使用翻译模型（需支持图片）"
            />
          </label>
          <label className="field">
            视觉接口
            <input
              type="url"
              value={visionUrl}
              onChange={(e) => setVisionUrl(e.target.value)}
              placeholder="留空沿用翻译接口"
            />
          </label>
          <label className="field">
            视觉 API Key
            <input
              type="password"
              autoComplete="off"
              value={visionKey}
              onChange={(e) => setVisionKey(e.target.value)}
              placeholder="留空沿用现有配置"
            />
          </label>
          <p className="muted">
            仅处理 Claude Code
            生成的图片。用户上传的图片直接发送，不进入翻译服务。
          </p>
        </div>
      </details>
      <p className="muted">
        翻译仅中继用户与 Claude Code
        的发言，参考最近五轮；思考固定关闭。配置加密保存。
      </p>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={pending}>
        {pending && <Busy />}保存连接
      </button>
    </form>
  );
}
export function SandboxManager({
  repo,
  onDestroyed,
  notify,
}: {
  repo: string;
  onDestroyed: () => void;
  notify: (text: string) => void;
}) {
  const [status, setStatus] = useState<Record<string, any>>(),
    [volumes, setVolumes] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [destroy, setDestroy] = useState(false),
    [phrase, setPhrase] = useState(""),
    [ack, setAck] = useState(false);
  async function refresh() {
    setPending(true);
    setError("");
    try {
      const result = await Promise.all([
        api<Record<string, any>>(`/sandbox/status?repo=${repo}`),
        api("/volumes"),
      ]);
      setStatus(result[0]);
      setVolumes(result[1]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [repo]);
  const work = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      const result = await fn();
      notify(typeof result === "object" ? JSON.stringify(result) : "完成");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const list = (
    Array.isArray(volumes)
      ? volumes
      : Array.isArray((volumes as any)?.volumes)
        ? (volumes as any).volumes
        : []
  ) as Record<string, any>[];
  return (
    <div className="form">
      <div className="panel-row">
        <span className="small-status">
          <Terminal size={15} />
          {repo} · {status?.running ? "运行中" : "已停止"}
        </span>
        <button
          className="secondary"
          disabled={pending}
          onClick={() => void refresh()}
        >
          <RotateCcw size={13} />
          刷新
        </button>
      </div>
      <div className="small-status">
        登录：
        {status?.auth?.loggedIn ? "已登录" : status?.auth?.note || "未验证"}
      </div>
      <SandboxLoginPanel repo={repo} onChanged={() => void refresh()} />
      {error && <p className="error">{error}</p>}
      <div className="button-row">
        {[
          { action: "start", label: "启动", icon: <Terminal size={13} /> },
          { action: "stop", label: "停止", icon: <Square size={13} /> },
          {
            action: "recreate",
            label: "重建容器",
            icon: <RotateCcw size={13} />,
          },
          {
            action: "network/cut",
            label: "紧急断网",
            icon: <WifiOff size={13} />,
          },
          {
            action: "network/restore",
            label: "恢复网络",
            icon: <Globe2 size={13} />,
          },
        ].map((a) => (
          <button
            className="secondary"
            disabled={pending}
            key={a.action}
            onClick={() =>
              void work(() =>
                api("/sandbox/action", { repo, action: a.action }),
              )
            }
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
      <h3>持久卷</h3>
      {["state", "work"].map((kind) => {
        const name = `cc-${kind}-${repo}`,
          info = list.find((v) => (v.name || v.id || v.volume) === name);
        return (
          <div className="volume-row" key={kind}>
            <div>
              <strong>{kind === "state" ? "会话和配置" : "工作区代码"}</strong>
              <code>{name}</code>
              {info && (
                <small>
                  {String(
                    info.size_human || info.size || info.size_bytes || "",
                  )}{" "}
                  · {info.in_use ? "占用中" : "未占用"}
                </small>
              )}
            </div>
            <button
              className="secondary"
              disabled={pending}
              onClick={() =>
                void work(() => api("/volumes/backup", { repo, volume: name }))
              }
            >
              <Download size={13} />
              备份
            </button>
          </div>
        );
      })}
      <p className="muted">
        卷包含明文会话或代码；重建容器保留卷，删除工作台会话也不会删除卷。
      </p>
      <details>
        <summary>容器与卷详情</summary>
        <JsonView value={{ status, volumes }} />
      </details>
      <div className="danger-zone">
        <button
          className="secondary danger-text"
          disabled={pending}
          onClick={() => setDestroy(true)}
        >
          <Trash2 size={13} />
          完全销毁此沙箱
        </button>
        {destroy && (
          <>
            <p>
              永久删除两个卷及本仓库的工作台记录，无法撤销。输入{" "}
              <code>永久删除 {repo}</code>：
            </p>
            <input
              aria-label="销毁确认文字"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              我理解会话和代码将永久删除。
            </label>
            <div className="button-row">
              <button className="secondary" onClick={() => setDestroy(false)}>
                取消
              </button>
              <button
                className="danger"
                disabled={pending || !ack || phrase !== `永久删除 ${repo}`}
                onClick={() => {
                  setPending(true);
                  void api("/volumes/destroy", {
                    repo,
                    confirmation: phrase,
                    acknowledge: ack,
                  })
                    .then(onDestroyed)
                    .catch((e) => setError("未完全销毁：" + e.message))
                    .finally(() => setPending(false));
                }}
              >
                确认永久删除
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
