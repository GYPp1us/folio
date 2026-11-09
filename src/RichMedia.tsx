import { useContext, useEffect, useRef, useState } from "react";
import { Code2, Maximize2, Image as ImageIcon } from "lucide-react";
import { ArtifactLink, RichContext } from "./rich-context";
import { api, Busy } from "./ui";
import { TranslateButton } from "./Process";
import { safeImageUrl } from "../shared/rich";
import type { Asset } from "../shared/types";
const requests = new Map<string, Promise<Asset>>();
export function AssetImage({
  asset,
  alt,
  className,
  onClick,
}: {
  asset: Asset;
  alt?: string;
  className?: string;
  onClick?: () => void;
}) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    if (asset.mime !== "image/svg+xml") return;
    const controller = new AbortController();
    let url = "";
    void fetch(`/api/assets/${asset.id}/content`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("读取图片失败");
        url = URL.createObjectURL(
          new Blob([await r.arrayBuffer()], { type: "image/svg+xml" }),
        );
        setSvg(url);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset.id, asset.mime]);
  if (asset.mime === "image/svg+xml" && !svg)
    return (
      <span className="image-loading">
        <ImageIcon size={18} />
      </span>
    );
  return (
    <img
      className={className}
      src={svg || `/api/assets/${asset.id}/content?inline=1`}
      alt={alt || asset.descriptionZh || asset.description || asset.name}
      title={asset.descriptionZh || asset.description || alt || asset.name}
      loading="lazy"
      onClick={onClick}
    />
  );
}
export function InlineAsset({
  kind,
  source,
  id,
  locale = "zh",
}: {
  kind?: "html" | "svg" | "image";
  source?: string;
  id?: string;
  locale?: "zh" | "en";
}) {
  const context = useContext(RichContext),
    open = useContext(ArtifactLink),
    [resolved, setResolved] = useState<Asset>(),
    [error, setError] = useState(""),
    [code, setCode] = useState(false),
    [height, setHeight] = useState(280);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "folio-preview-size" ||
        typeof event.data.height !== "number" ||
        !Number.isFinite(event.data.height)
      )
        return;
      setHeight(Math.max(40, Math.min(600, Math.ceil(event.data.height))));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!context.sessionId) return;
    let disposed = false;
    setError("");
    setResolved(undefined);
    setCode(false);
    const key = context.sessionId + ":" + (id || kind + ":" + source);
    let request = requests.get(key);
    if (!request) {
      request = id
        ? api<Asset>(`/assets/${id}`)
        : api<Asset>("/inline", { sessionId: context.sessionId, kind, source });
      requests.set(key, request);
      if (requests.size > 200) requests.delete(requests.keys().next().value!);
    }
    void request
      .then((a) => {
        if (!disposed) {
          setResolved(a);
          context.onAsset(a);
        }
      })
      .catch((e) => {
        requests.delete(key);
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [context.sessionId, id, kind, source]);
  const asset = context.assets.find((a) => a.id === resolved?.id) || resolved;
  const apply = () => {
    if (asset)
      frame.current?.contentWindow?.postMessage(
        {
          type: "folio-locale",
          locale,
          dictionary: locale === "zh" ? asset.translatedCatalog : asset.catalog,
          descriptions: Object.fromEntries(
            (asset.children || []).map((id) => {
              const image = context.assets.find((a) => a.id === id);
              return [
                id,
                locale === "zh"
                  ? image?.descriptionZh || ""
                  : image?.description || "",
              ];
            }),
          ),
        },
        "*",
      );
  };
  useEffect(apply, [locale, asset, context.assets]);
  return (
    <span
      className={`rich-media ${asset?.kind === "image" ? "rich-image" : ""}`}
    >
      <span className="rich-media-toolbar">
        <span>
          {asset?.kind === "image" ? "图片" : kind === "svg" ? "SVG" : "HTML"}
        </span>
        {!asset && !error && <Busy />}
        {source && kind !== "image" && (
          <button className="text-button" onClick={() => setCode((v) => !v)}>
            <Code2 size={12} />
            {code ? "预览" : "源码"}
          </button>
        )}
        {asset &&
          !asset.translatedCatalog &&
          !asset.descriptionZh &&
          asset.origin === "output" && (
            <TranslateButton
              path={`/assets/${asset.id}/translate`}
              state={asset.translationState}
              error={asset.translationError}
              onError={context.onError}
            />
          )}
        {asset && (
          <button className="text-button" onClick={() => open(asset.id)}>
            <Maximize2 size={12} />
            放大
          </button>
        )}
      </span>
      {code ? (
        <pre>
          <code>{source}</code>
        </pre>
      ) : error ? (
        <span className="error">{error}</span>
      ) : asset?.kind === "html" ? (
        <iframe
          ref={frame}
          src={`/api/assets/${asset.id}/preview?locale=en`}
          title={asset.title || "HTML 预览"}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={apply}
          style={{ height }}
        />
      ) : asset?.kind === "image" ? (
        <AssetImage asset={asset} onClick={() => open(asset.id)} />
      ) : !asset ? (
        <span className="muted rich-loading">正在准备预览…</span>
      ) : (
        <span className="muted">此文件可通过放大入口查看。</span>
      )}
    </span>
  );
}
export function ReplyImage({
  src,
  alt,
  locale,
}: {
  src?: string;
  alt?: string;
  locale?: "zh" | "en";
}) {
  const [failed, setFailed] = useState(false),
    [expanded, setExpanded] = useState(false);
  if (!src) return null;
  const id = /^folio-asset:\/\/([a-f0-9-]{36})$/i.exec(src)?.[1];
  if (id) return <InlineAsset id={id} locale={locale} />;
  if (/^data:image\//i.test(src) && src.length <= 6 * 1024 * 1024)
    return <InlineAsset kind="image" source={src} locale={locale} />;
  if (!safeImageUrl(src))
    return <InlineAsset kind="image" source={src} locale={locale} />;
  return (
    <span className={`reply-image ${expanded ? "expanded" : ""}`}>
      <img
        src={src}
        alt={alt || "Claude Code 图片"}
        title={alt || "点击缩放"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        onClick={() => setExpanded((v) => !v)}
      />
      {failed && <span className="muted">图片未能加载</span>}
    </span>
  );
}
