import { useEffect, useRef, useState } from "react";
import {
  Download,
  File,
  FileCode2,
  Image,
  ShieldAlert,
  X,
  AtSign,
} from "lucide-react";
import { api, Busy, Modal, Picker } from "./ui";
import { AssetImage } from "./RichMedia";
import { TranslateButton } from "./Process";
import type { Asset } from "../shared/types";

const contentUrl = (a: Asset) => `/api/assets/${a.id}/content`;
const bytesLabel = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.ceil(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
export async function uploadFile(sessionId: string, file: globalThis.File) {
  const response = await fetch(`/api/uploads/${sessionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "上传失败");
  return value as Asset;
}
export function AssetRail({
  assets,
  onOpen,
  onRemove,
  onReference,
  onError,
}: {
  assets: Asset[];
  onOpen: (a: Asset) => void;
  onRemove?: (a: Asset) => void;
  onReference?: (a: Asset) => void;
  onError?: (message: string) => void;
}) {
  if (!assets.length) return null;
  return (
    <div className="asset-rail">
      {assets.map((a) => (
        <div
          className={`asset-card ${a.approval === "pending" ? "needs-review" : ""}`}
          key={a.id}
        >
          <button
            className="asset-main"
            onClick={() => onOpen(a)}
            title={a.descriptionZh || a.description || a.title || a.name}
          >
            {a.kind === "image" ? (
              <AssetImage asset={a} alt={a.name} />
            ) : (
              <span className="asset-icon">
                {a.kind === "html" ? (
                  <FileCode2 size={20} />
                ) : (
                  <File size={20} />
                )}
              </span>
            )}
            <span>
              <strong>{a.title || a.name}</strong>
              <small>
                {a.approval === "pending" ? (
                  <>
                    <ShieldAlert size={10} />
                    待确认
                  </>
                ) : (
                  bytesLabel(a.size)
                )}
                {a.origin === "upload" && a.kind === "image" && " · 原图"}
              </small>
            </span>
          </button>
          {onReference && (
            <button
              className="icon asset-reference"
              title={`引用 @${a.name}`}
              aria-label={`引用 ${a.name}`}
              onClick={() => onReference(a)}
            >
              <AtSign size={12} />
            </button>
          )}
          {a.origin === "output" &&
            ["html", "image"].includes(a.kind) &&
            !(a.translatedCatalog || a.descriptionZh) &&
            onError && (
              <div className="asset-translate">
                <TranslateButton
                  path={`/assets/${a.id}/translate`}
                  state={a.translationState}
                  error={a.translationError}
                  onError={onError}
                />
              </div>
            )}
          {onRemove && (
            <button
              className="icon asset-remove"
              title="移除附件"
              aria-label={`移除 ${a.name}`}
              onClick={() => onRemove(a)}
            >
              <X size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
export function AssetPreview({
  asset: a,
  all,
  onClose,
  onUpdate,
  onError,
}: {
  asset?: Asset;
  all: Asset[];
  onClose: () => void;
  onUpdate: (a: Asset) => void;
  onError: (s: string) => void;
}) {
  const [tab, setTab] = useState("preview"),
    [locale, setLocale] = useState("zh"),
    [source, setSource] = useState(""),
    [pdf, setPdf] = useState(""),
    [svgUrl, setSvgUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [choices, setChoices] = useState<Record<string, string>>({});
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    setTab("preview");
    setSource("");
    setPdf("");
    setSvgUrl("");
    setChoices({});
    setLocale("zh");
  }, [a?.id]);
  useEffect(() => {
    if (
      !a ||
      (a.kind !== "text" &&
        tab !== "source" &&
        a.kind !== "pdf" &&
        a.mime !== "image/svg+xml")
    )
      return;
    const controller = new AbortController();
    let url = "";
    void fetch(contentUrl(a), { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("读取文件失败");
        if (a.mime === "image/svg+xml") {
          url = URL.createObjectURL(
            new Blob([await r.arrayBuffer()], { type: a.mime }),
          );
          setSvgUrl(url);
        } else if (a.kind === "pdf") {
          url = URL.createObjectURL(
            new Blob([await r.arrayBuffer()], { type: "application/pdf" }),
          );
          setPdf(url);
        } else setSource((await r.text()).slice(0, 2000000));
      })
      .catch((e) => {
        if (!controller.signal.aborted) onError(e.message);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [a?.id, tab]);
  function updateFrame() {
    if (!a) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: "folio-locale",
        locale,
        dictionary: locale === "zh" ? a.translatedCatalog : a.catalog,
        descriptions: Object.fromEntries(
          (a.children || []).map((id) => {
            const child = all.find((a) => a.id === id);
            return [
              id,
              locale === "zh"
                ? child?.descriptionZh || ""
                : child?.description || "",
            ];
          }),
        ),
      },
      "*",
    );
  }
  useEffect(updateFrame, [locale, a?.translatedCatalog, all]);
  if (!a) return null;
  const translatable =
    a.origin === "output" && (a.kind === "html" || a.kind === "image");
  return (
    <Modal
      open={!!a}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={a.title || a.name}
      description={`${a.name} · ${bytesLabel(a.size)}`}
      wide
    >
      {a.approval === "pending" ? (
        <div className="form asset-decisions">
          <p>
            {a.scan === "unscanned"
              ? "此格式无法检查文本。可选择原样交给 Claude Code，或关闭后移除附件。"
              : "请选择文件中敏感内容的处理方式。占位符会写入发送副本，原文件保留。"}
          </p>
          {(a.findings || []).map((f) => (
            <div className="asset-finding" key={f.id}>
              <span>
                <small>{f.label}</small>
                <code>{f.value}</code>
              </span>
              <Picker
                label={`处理 ${f.label}`}
                value={choices[f.id] || f.strategy}
                options={[
                  { value: "pending", label: "选择处理" },
                  { value: "placeholder", label: "占位符" },
                  { value: "pass", label: "原样透传" },
                ]}
                onChange={(v) => setChoices((c) => ({ ...c, [f.id]: v }))}
              />
            </div>
          ))}
          <button
            className="primary"
            disabled={
              busy ||
              (a.findings || []).some(
                (f) => (choices[f.id] || f.strategy) === "pending",
              )
            }
            onClick={() => {
              setBusy(true);
              void api<Asset>(`/assets/${a.id}/decisions`, {
                allowUnscanned: a.scan === "unscanned",
                decisions: (a.findings || []).map((f) => ({
                  id: f.id,
                  strategy: choices[f.id] || f.strategy,
                })),
              })
                .then(onUpdate)
                .catch((e) => onError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy && <Busy />}
            {a.scan === "unscanned" ? "确认原样发送此文件" : "保存文件隐私选择"}
          </button>
        </div>
      ) : (
        <>
          <div className="artifact-toolbar">
            <div className="segmented">
              <button
                className={tab === "preview" ? "active" : ""}
                onClick={() => setTab("preview")}
              >
                预览
              </button>
              {(a.kind === "html" || a.kind === "text") && (
                <button
                  className={tab === "source" ? "active" : ""}
                  onClick={() => setTab("source")}
                >
                  源文件
                </button>
              )}
            </div>
            {a.kind === "html" && tab === "preview" && (
              <Picker
                label="页面语言"
                value={locale}
                onChange={setLocale}
                options={[
                  {
                    value: "zh",
                    label: a.translatedCatalog ? "中文页面" : "中文（待翻译）",
                  },
                  { value: "en", label: "原文页面" },
                ]}
              />
            )}
            {translatable && !(a.translatedCatalog || a.descriptionZh) && (
              <TranslateButton
                path={`/assets/${a.id}/translate`}
                state={a.translationState}
                error={a.translationError}
                onError={onError}
              />
            )}
            <a
              className="text-button artifact-download"
              href={contentUrl(a)}
              download={a.name}
            >
              <Download size={12} />
              下载
            </a>
          </div>
          <div className="artifact-preview">
            {tab === "source" || a.kind === "text" ? (
              <pre className="artifact-source">{source || "读取中…"}</pre>
            ) : a.kind === "html" && a.previewReady ? (
              <iframe
                ref={frame}
                title={a.title || a.name}
                src={`/api/assets/${a.id}/preview?locale=zh`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                onLoad={updateFrame}
              />
            ) : a.kind === "image" && (a.mime !== "image/svg+xml" || svgUrl) ? (
              <img
                className="output-image"
                src={svgUrl || contentUrl(a) + "?inline=1"}
                alt={a.descriptionZh || a.description || a.name}
                title={a.descriptionZh || a.description || a.name}
              />
            ) : a.kind === "pdf" && pdf ? (
              <iframe title={a.name} src={pdf} sandbox="" />
            ) : (
              <p className="muted">
                {a.previewError || "此文件可下载后查看。"}
              </p>
            )}
          </div>
          {(a.descriptionZh || a.description) && (
            <p className="image-description">
              {locale === "zh"
                ? a.descriptionZh || a.description
                : a.description}
            </p>
          )}
          {a.translationError && <p className="error">{a.translationError}</p>}
          {(a.children || []).length > 0 && (
            <div className="page-images">
              <span className="language-label">页面图片 · 点击查看描述</span>
              <AssetRail
                assets={all.filter((child) => a.children?.includes(child.id))}
                onOpen={onUpdate}
              />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
