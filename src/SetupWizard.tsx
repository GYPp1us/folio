import { useEffect, useState } from "react";
import { api, Busy } from "./ui";
type Defaults = {
  oauthConfigured: boolean;
  translatorUrl: string;
  translatorModel: string;
  translatorProtocol?: string;
  sandboxConfigured: boolean;
  sandboxUrl: string;
  retentionDays: number;
  repo: string;
};
export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [status, setStatus] = useState<{
      unlocked: boolean;
      needsInstallCode: boolean;
      defaults?: Defaults;
    }>(),
    [step, setStep] = useState(0),
    [code, setCode] = useState(""),
    [oauth, setOauth] = useState(""),
    [url, setUrl] = useState(""),
    [model, setModel] = useState(""),
    [key, setKey] = useState(""),
    [protocol, setProtocol] = useState("auto"),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [repo, setRepo] = useState("my-project"),
    [days, setDays] = useState(30),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function refresh() {
    const result = await api<{
      required: boolean;
      unlocked: boolean;
      needsInstallCode: boolean;
      defaults?: Defaults;
    }>("/setup/status");
    if (!result.required) {
      onComplete();
      return;
    }
    setStatus(result);
    if (result.defaults) {
      setUrl(result.defaults.translatorUrl);
      setModel(result.defaults.translatorModel);
      setProtocol(result.defaults.translatorProtocol || "auto");
      setRepo(result.defaults.repo);
      setDays(result.defaults.retentionDays);
    }
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function work(fn: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="setup">
      <div className="setup-heading">
        <span className="wordmark">Folio</span>
        <span>首次配置</span>
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void work(async () => {
            if (!status?.unlocked) {
              if (status?.needsInstallCode)
                await api("/setup/unlock", { code });
              else await api("/auth", { password: code });
              setCode("");
              await refresh();
              return;
            }
            if (step < 2) {
              setStep(step + 1);
              setMessage("");
              return;
            }
            if (password !== confirm) throw new Error("两次访问密码不一致");
            await api("/setup/complete", {
              oauthToken: oauth,
              translatorUrl: url,
              translatorModel: model,
              translatorKey: key,
              translatorProtocol: protocol,
              password,
              repo,
              retentionDays: days,
            });
            onComplete();
          });
        }}
      >
        {!status ? (
          <div className="small-status">
            <Busy />
            读取安装状态
          </div>
        ) : !status.unlocked ? (
          <>
            <label className="field">
              {status.needsInstallCode ? "安装码" : "现有访问密码"}
              <input
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <p className="muted">
              在服务器读取：<code>sudo cat /etc/folio/bootstrap-token</code>
            </p>
          </>
        ) : (
          <>
            <div className="tabs">
              {["Claude Code", "翻译服务", "访问与数据"].map((label, index) => (
                <button
                  type="button"
                  key={label}
                  className={step === index ? "active" : ""}
                  disabled={index > step}
                  onClick={() => setStep(index)}
                >
                  {index + 1}. {label}
                </button>
              ))}
            </div>
            {step === 0 ? (
              <>
                <label className="field">
                  Claude OAuth token
                  <input
                    type="password"
                    autoComplete="off"
                    value={oauth}
                    onChange={(e) => setOauth(e.target.value)}
                    placeholder={
                      status.defaults?.oauthConfigured
                        ? "已配置，留空保留"
                        : "claude setup-token 的结果"
                    }
                    required={!status.defaults?.oauthConfigured}
                  />
                </label>
                <p className="muted">
                  运行 <code>claude setup-token</code>{" "}
                  获取。令牌加密保存到服务器。
                </p>
                <div className="panel-row">
                  <code>{status.defaults?.sandboxUrl}</code>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending || !status.defaults?.sandboxConfigured}
                    onClick={() =>
                      void work(async () => {
                        const result = await api<{ message: string }>(
                          "/setup/check",
                          { kind: "sandbox" },
                        );
                        setMessage(result.message);
                      })
                    }
                  >
                    检查沙箱
                  </button>
                </div>
              </>
            ) : step === 1 ? (
              <>
                <label className="field">
                  翻译接口
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://provider.example/v1"
                    required
                  />
                </label>
                <label className="field">
                  模型
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  API Key
                  <input
                    type="password"
                    autoComplete="off"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="留空保留已有凭证"
                  />
                </label>
                <label className="field">
                  关闭思考协议
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value)}
                  >
                    <option value="auto">按模型识别</option>
                    <option value="openai">OpenAI</option>
                    <option value="thinking">DeepSeek / GLM / Kimi</option>
                    <option value="qwen">Qwen / Ollama</option>
                    <option value="off">网关（reasoning_effort: off）</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || !url}
                  onClick={() =>
                    void work(async () => {
                      const result = await api<{ message: string }>(
                        "/setup/check",
                        {
                          kind: "translator",
                          translatorUrl: url,
                          translatorModel: model,
                          translatorKey: key,
                          translatorProtocol: protocol,
                        },
                      );
                      setMessage(result.message);
                    })
                  }
                >
                  测试翻译
                </button>
                <p className="muted">
                  翻译仅中继用户与 Claude Code 对话，关闭思考，参考最近五轮。
                </p>
              </>
            ) : (
              <>
                <label className="field">
                  访问密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={256}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  确认密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  第一个沙箱
                  <input
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    pattern="[a-z0-9][a-z0-9_-]{0,47}"
                    required
                  />
                </label>
                <label className="field">
                  工作台记录保留天数
                  <input
                    type="number"
                    min={1}
                    max={730}
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                    required
                  />
                </label>
                <p className="muted">沙箱卷独立保留，含明文会话与代码。</p>
              </>
            )}
          </>
        )}
        {message && <p className="success">{message}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row end">
          {step > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={pending}
              onClick={() => setStep(step - 1)}
            >
              返回
            </button>
          )}
          <button className="primary" disabled={pending || !status}>
            {pending && <Busy />}
            {!status?.unlocked
              ? "验证安装码"
              : step === 2
                ? "保存并进入"
                : "继续"}
          </button>
        </div>
      </form>
    </div>
  );
}
