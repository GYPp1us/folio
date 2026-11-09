import { fromMarkdown } from "mdast-util-from-markdown";
import { parseFragment } from "parse5";
export type RichPart = {
  start: number;
  end: number;
  kind: "html" | "svg";
  source: string;
};
const visible =
  /^(?:!doctype|html|head|body|div|section|article|main|aside|header|footer|nav|table|details|figure|form|style|script|canvas|svg|p|span|button|ul|ol|dl|h[1-6]|blockquote|pre|img|video|audio|strong|em|b|i|a|label|input|select|textarea)\b/i;
export function richParts(text: string): RichPart[] {
  if (!/<[a-z!]|```(?:html|svg|xml)/i.test(text)) return [];
  const tree = fromMarkdown(text),
    result: RichPart[] = [];
  const walk = (node: any, parent?: any) => {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (typeof start === "number" && typeof end === "number") {
      if (
        node.type === "code" &&
        /^(html?|svg|xml)$/i.test(node.lang || "") &&
        /^\s*<(?:!doctype|[a-z])/i.test(node.value)
      ) {
        // Do not create transient assets from an unfinished streaming fence.
        if (
          /^xml$/i.test(node.lang || "") &&
          !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(node.value)
        )
          return;
        const raw = text.slice(start, end);
        if (/\n\s*(?:`{3,}|~{3,})\s*$/.test(raw))
          result.push({
            start,
            end,
            kind: /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(node.value)
              ? "svg"
              : "html",
            source: node.value,
          });
        return;
      }
      if (node.type === "html" && visible.test(node.value.replace(/^</, ""))) {
        if (parent?.type !== "paragraph") {
          result.push({
            start,
            end,
            kind: /^\s*<svg\b/i.test(node.value) ? "svg" : "html",
            source: node.value,
          });
        } else {
          const fragment = parseFragment(text.slice(start), {
            sourceCodeLocationInfo: true,
          }) as any;
          const element = fragment.childNodes.find((n: any) => n.tagName);
          const location = element?.sourceCodeLocation;
          if (
            location?.startOffset === 0 &&
            (location.endTag || ["img", "input"].includes(element.tagName))
          ) {
            result.push({
              start,
              end: start + location.endOffset,
              kind: element.tagName === "svg" ? "svg" : "html",
              source: text.slice(start, start + location.endOffset),
            });
          }
        }
      }
    }
    for (const child of node.children || []) walk(child, node);
  };
  walk(tree);
  const ordered = result.sort((a, b) => a.start - b.start || b.end - a.end),
    filtered: RichPart[] = [];
  for (const part of ordered)
    if (!filtered.length || part.start >= filtered.at(-1)!.end)
      filtered.push(part);
  return filtered.slice(0, 24);
}
export function replaceRich(
  text: string,
  parts: RichPart[],
  replace: (part: RichPart, index: number) => string,
) {
  let output = "",
    at = 0;
  parts.forEach((p, i) => {
    output += text.slice(at, p.start) + replace(p, i);
    at = p.end;
  });
  return output + text.slice(at);
}
export function safeImageUrl(url: string) {
  return (
    /^https?:\/\//i.test(url) ||
    /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)(?:;[^,]*)?,/i.test(
      url,
    ) ||
    /^\/api\/assets\/[a-f0-9-]{36}\/content(?:\?inline=1)?$/i.test(url)
  );
}
