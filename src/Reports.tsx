import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { api, Busy, Modal } from "./ui";
import type { Report } from "../shared/reports";

const states = {
  ready: "静态快照",
  running: "运行中",
  stopped: "已停止",
  error: "异常",
};
export function ReportsPage() {
  const id = /^\/report\/([a-f0-9-]{36})\/?$/.exec(location.pathname)?.[1];
  const [reports, setReports] = useState<Report[]>([]),
    [report, setReport] = useState<Report>(),
    [src, setSrc] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(""),
    [locale, setLocale] = useState<"zh" | "en">("zh"),
    [logs, setLogs] = useState<string>(),
    [remove, setRemove] = useState<Report>();
  const frame = useRef<HTMLIFrameElement>(null);
  const frameSource = useRef("");
  const refresh = useCallback(async () => {
    setError("");
    try {
      if (id) {
        if (frameSource.current) {
          setReport(await api<Report>(`/reports/${id}`));
          return;
        }
        const value = await api<{ report: Report; src: string }>(
          `/reports/${id}/view`,
          {},
        );
        setReport(value.report);
        setSrc(value.src);
        frameSource.current = value.src;
      } else setReports(await api<Report[]>("/reports"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const recovered = () => {
      frameSource.current = "";
      void refresh();
    };
    window.addEventListener("folio-connection-restored", recovered);
    return () =>
      window.removeEventListener("folio-connection-restored", recovered);
  }, [refresh]);
  useEffect(() => {
    if (
      !id ||
      !report ||
      (report.kind !== "service" && report.translationState !== "pending")
    )
      return;
    const timer = setInterval(
      () => {
        void api<Report>(`/reports/${id}`)
          .then(setReport)
          .catch(() => {});
      },
      report.translationState === "pending" ? 2000 : 30000,
    );
    return () => clearInterval(timer);
  }, [id, report?.kind, report?.translationState]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "folio-locale", locale, dictionary: report?.translatedCatalog },
      "*",
    );
  }, [locale, report?.translatedCatalog]);
  const act = async (name: string, task: () => Promise<unknown>) => {
    setPending(name);
    setError("");
    try {
      await task();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending("");
    }
  };
  const rows = id && report ? [report] : reports;
  return (
    <div className="reports-page">
      <header className="report-topbar">
        <a href={id ? "/report" : "/"} className="button-link">
          <ArrowLeft size={15} />
          {id ? "Reports" : "返回会话"}
        </a>
        <span className="wordmark">{report?.title || "Reports"}</span>
        <button
          className="icon"
          aria-label="刷新发布列表"
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!id && !reports.length && !error && (
        <p className="report-empty">
          尚无发布。让 Claude 发布报告、Demo 或临时服务，链接会出现在这里。
        </p>
      )}
      {rows.map((r) => (
        <div className="report-item" key={r.id}>
          <FileText size={17} />
          <div>
            <a href={`/report/${r.id}/`}>{r.title}</a>
            <small>
              {r.repo} ·{" "}
              {
                states[
                  r.expiresAt && Date.parse(r.expiresAt) < Date.now()
                    ? "stopped"
                    : r.state
                ]
              }{" "}
              · {new Date(r.createdAt).toLocaleString()}
              {r.expiresAt
                ? ` · ${new Date(r.expiresAt).toLocaleString()} 到期`
                : r.size !== undefined
                  ? ` · ${(r.size / 1024).toFixed(1)} KB`
                  : ""}
            </small>
          </div>
          <div className="report-actions">
            {!id && (
              <a className="icon" href={`/report/${r.id}/`} title="打开报告">
                <ExternalLink size={14} />
              </a>
            )}
            {r.kind === "service" && (
              <button
                onClick={() =>
                  void act("logs", async () =>
                    setLogs(
                      (await api<{ text: string }>(`/reports/${r.id}/logs`))
                        .text,
                    ),
                  )
                }
              >
                日志
              </button>
            )}
            {r.kind === "service" && r.state === "running" && (
              <button
                className="icon"
                aria-label={`停止 ${r.title}`}
                disabled={!!pending}
                onClick={() =>
                  void act("stop", () => api(`/reports/${r.id}/stop`, {}))
                }
              >
                <Square size={14} />
              </button>
            )}
            <button
              className="icon"
              aria-label={`删除 ${r.title}`}
              disabled={!!pending}
              onClick={() => setRemove(r)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      {report && src && (
        <>
          <div className="report-view-toolbar">
            <span>{report.kind === "service" ? "临时服务" : "报告"}</span>
            {(report.kind === "static" ||
              report.catalog ||
              report.translationState) && (
              <>
                <button
                  className={locale === "zh" ? "active" : ""}
                  onClick={() => setLocale("zh")}
                >
                  中文
                </button>
                <button
                  className={locale === "en" ? "active" : ""}
                  onClick={() => setLocale("en")}
                >
                  原文
                </button>
                {report.translationState === "pending" ? (
                  <Busy />
                ) : (
                  report.translationState !== "done" && (
                    <button
                      disabled={!!pending}
                      onClick={() =>
                        void act("translate", () =>
                          api(`/reports/${report.id}/translate`, {}),
                        )
                      }
                    >
                      翻译页面
                    </button>
                  )
                )}
              </>
            )}
          </div>
          {report.state === "stopped" ? (
            <p className="muted">服务已停止。可让 Claude 重新发布。</p>
          ) : (
            <iframe
              ref={frame}
              className="report-frame"
              src={`${src}?locale=zh`}
              title={report.title}
              sandbox="allow-scripts allow-forms allow-downloads"
              referrerPolicy="no-referrer"
              onLoad={() =>
                frame.current?.contentWindow?.postMessage(
                  {
                    type: "folio-locale",
                    locale,
                    dictionary: report.translatedCatalog,
                  },
                  "*",
                )
              }
            />
          )}
        </>
      )}
      <Modal
        open={logs !== undefined}
        onOpenChange={(open) => {
          if (!open) setLogs(undefined);
        }}
        title="服务日志"
        wide
      >
        <pre className="json-view">{logs || "暂无日志"}</pre>
      </Modal>
      <Modal
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(undefined);
        }}
        title="删除发布"
      >
        <p>
          删除“{remove?.title}
          ”及其发布快照，运行中的服务也会停止。工作区源文件保留。
        </p>
        <button
          className="danger"
          disabled={!!pending}
          onClick={() => {
            if (remove)
              void act("delete", async () => {
                await api(`/reports/${remove.id}`, undefined, "DELETE");
                setRemove(undefined);
                if (id) location.href = "/report";
              });
          }}
        >
          确认删除
        </button>
      </Modal>
    </div>
  );
}
