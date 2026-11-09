import { useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn } from "lucide-react";
import { api, Busy } from "./ui";
import type { SandboxLogin } from "../shared/types";
const inProgress = (flow?: SandboxLogin) =>
  !!flow && ["starting", "awaiting", "verifying"].includes(flow.status);
export function SandboxLoginPanel({
  repo,
  onChanged,
}: {
  repo: string;
  onChanged: () => void;
}) {
  const [flow, setFlow] = useState<SandboxLogin>(),
    [mode, setMode] = useState("token"),
    [code, setCode] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const completed = useRef("");
  async function read() {
    const value = await api<{ flow: SandboxLogin | null; mode: string }>(
      `/sandbox/login?repo=${encodeURIComponent(repo)}`,
    );
    setFlow(value.flow || undefined);
    setMode(value.mode);
    return value;
  }
  useEffect(() => {
    setFlow(undefined);
    setCode("");
    setError("");
    void read().catch((e) => setError(e.message));
  }, [repo]);
  useEffect(() => {
    if (!inProgress(flow)) return;
    const timer = setInterval(
      () => void read().catch((e) => setError(e.message)),
      1500,
    );
    return () => clearInterval(timer);
  }, [repo, flow?.id, flow?.status]);
  useEffect(() => {
    if (flow?.status === "complete" && completed.current !== flow.id) {
      completed.current = flow.id;
      setMode("web");
      setCode("");
      onChanged();
    }
  }, [flow?.id, flow?.status]);
  async function perform(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="sandbox-login">
      <div className="panel-row">
        <strong>Claude 登录</strong>
        <span className="muted">
          {mode === "web" ? "网页登录" : "长期 token"}
        </span>
      </div>
      <p className="muted">
        {mode === "web"
          ? "凭证由此沙箱的 Claude Code 自动刷新，保存在状态卷中。"
          : "长期 token 可运行任务；查询套餐用量需要完成网页登录。"}
      </p>
      {!inProgress(flow) && (
        <div className="button-row">
          <button
            className="secondary"
            disabled={pending}
            onClick={() =>
              void perform(async () => {
                setFlow(await api<SandboxLogin>("/sandbox/login", { repo }));
                setCode("");
              })
            }
          >
            <LogIn size={13} />
            {mode === "web" ? "重新网页登录" : "网页登录，启用套餐用量"}
          </button>
          {mode === "web" && (
            <button
              className="text-button"
              disabled={pending}
              onClick={() =>
                void perform(async () => {
                  await api("/sandbox/login/token", { repo });
                  await read();
                  onChanged();
                })
              }
            >
              改用长期 token
            </button>
          )}
        </div>
      )}
      {inProgress(flow) && (
        <>
          <div className="small-status">
            <Busy />
            {flow!.status === "starting"
              ? "正在启动原生登录…"
              : flow!.status === "verifying"
                ? "正在验证授权…"
                : "等待浏览器授权"}
          </div>
          {flow!.url && (
            <>
              <a
                className="secondary button-link"
                href={flow!.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={13} />
                打开 Claude 授权页
              </a>
              <p className="muted">
                在浏览器登录并同意授权。服务器不能自动接收浏览器回调时，将页面显示的一次性授权码粘贴到下面。
              </p>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!code.trim()) return;
                  void perform(async () => {
                    setFlow(
                      await api<SandboxLogin>("/sandbox/login/code", {
                        repo,
                        id: flow!.id,
                        code,
                      }),
                    );
                    setCode("");
                  });
                }}
              >
                <label className="field">
                  一次性授权码
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={code}
                    disabled={pending || flow!.status === "verifying"}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="仅发送给此沙箱的登录进程"
                  />
                </label>
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={
                      pending || !code.trim() || flow!.status === "verifying"
                    }
                  >
                    提交授权码
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={pending}
                    onClick={() =>
                      void perform(async () => {
                        await api("/sandbox/login/cancel", { repo });
                        await read();
                        setCode("");
                      })
                    }
                  >
                    取消登录
                  </button>
                </div>
              </form>
            </>
          )}
          {!flow!.url && (
            <button
              className="text-button"
              disabled={pending}
              onClick={() =>
                void perform(async () => {
                  await api("/sandbox/login/cancel", { repo });
                  await read();
                })
              }
            >
              取消登录
            </button>
          )}
        </>
      )}
      {flow?.status === "complete" && mode === "web" && (
        <p className="success">网页登录已完成。可通过 /usage 查询套餐用量。</p>
      )}
      {(error || flow?.error) && (
        <p className="error" role="alert">
          {error || flow?.error}
        </p>
      )}
      <p className="muted">
        网页登录凭证含刷新令牌，保存在状态卷中。重建容器保留登录；默认备份排除标准凭证文件，恢复后需重新授权。
      </p>
    </section>
  );
}
