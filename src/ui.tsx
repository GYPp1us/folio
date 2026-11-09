import type { ReactNode, RefObject } from "react";
import { memo, useContext, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Copy, LoaderCircle, X } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactLink } from "./rich-context";
import { InlineAsset, ReplyImage } from "./RichMedia";
import { richParts, replaceRich, safeImageUrl } from "../shared/rich";
export { ArtifactLink } from "./rich-context";
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (
    response.status === 401 &&
    path !== "/auth" &&
    typeof window !== "undefined"
  )
    window.dispatchEvent(new Event("folio-disconnected"));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""}`}
          onCloseAutoFocus={
            returnFocus
              ? (event) => {
                  event.preventDefault();
                  returnFocus.current?.focus({ preventScroll: true });
                }
              : undefined
          }
        >
          <div className="modal-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon" aria-label="关闭">
              <X size={17} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="modal-description">
            {description || ""}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Picker({
  value,
  onChange,
  options,
  label,
  disabled = false,
  onOpen,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
  onOpen?: () => void;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <Select.Trigger className="picker" aria-label={label} title={label}>
        <Select.Value placeholder={label} />
        <Select.Icon>
          <ChevronDown size={12} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="select-content"
          position="popper"
          sideOffset={5}
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                className="select-item"
                value={option.value}
                key={option.value}
                disabled={option.disabled}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={13} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
export const RichText = memo(function RichText({
  text,
  rich = true,
  locale = "zh",
}: {
  text: string;
  rich?: boolean;
  locale?: "zh" | "en";
}) {
  const open = useContext(ArtifactLink);
  const parts = useMemo(() => (rich ? richParts(text) : []), [text, rich]);
  const markdown = replaceRich(
    text,
    parts,
    (_p, i) => `![预览](folio-inline://${i})`,
  )
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/__YJ_[A-Za-z0-9_]+__/g, (token) =>
            token.replace(/_/g, "\\_"),
          ),
    )
    .join("");
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <div className="markdown-paragraph">{children}</div>,
      img: ({ src, alt }) => {
        if (!rich)
          return (
            <span>
              {alt} ({src})
            </span>
          );
        const index = /^folio-inline:\/\/(\d+)$/.exec(src || "")?.[1],
          part = index === undefined ? undefined : parts[Number(index)];
        return part ? (
          <InlineAsset kind={part.kind} source={part.source} locale={locale} />
        ) : (
          <ReplyImage src={src} alt={alt} locale={locale} />
        );
      },
      a: ({ href, children }) =>
        href?.startsWith("folio-asset://") ? (
          <button
            className="text-button artifact-inline-link"
            onClick={() => open(href.slice(14))}
          >
            {children}
          </button>
        ) : (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
    }),
    [rich, parts, locale, open],
  );
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) =>
          /^folio-asset:\/\/[a-f0-9-]{36}$/i.test(url) ||
          (key === "src" &&
            (safeImageUrl(url) ||
              /^folio-inline:\/\/\d+$/.test(url) ||
              /^(?:\/?work\/|file:|\.{0,2}\/|[^:/]+\.(?:png|jpe?g|gif|webp|svg))/i.test(
                url,
              )))
            ? url
            : defaultUrlTransform(url)
        }
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
});

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon"
      title="复制"
      aria-label="复制"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
export function Busy() {
  return <LoaderCircle className="spin" size={14} />;
}
