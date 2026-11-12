import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function usePortraitSwipe(enabled: boolean, open: () => void) {
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const finish = (event: PointerEvent<HTMLElement>) => {
    if (start.current?.id === event.pointerId) start.current = null;
  };
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "touch") return;
      start.current = null;
      if (!enabled || !event.isPrimary || !(event.target instanceof Element))
        return;
      const target = event.target;
      if (
        !target.closest(".conversation-window, .topbar") ||
        target.closest(
          "button, a, input, textarea, select, summary, mark, pre, table, iframe, img, [contenteditable], [role=button]",
        )
      )
        return;
      start.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const origin = start.current;
      if (!enabled || !origin || origin.id !== event.pointerId) return;
      const left = origin.x - event.clientX;
      const vertical = Math.abs(origin.y - event.clientY);
      if (vertical > 14 && vertical >= Math.abs(left)) {
        start.current = null;
        return;
      }
      if (
        left >= 56 &&
        left > vertical * 1.4 &&
        window.getSelection()?.isCollapsed !== false
      ) {
        start.current = null;
        open();
      }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
  };
}

export function useDrawerFocus(open: boolean) {
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open) close.current?.focus({ preventScroll: true });
    else if (wasOpen.current && trigger.current?.getClientRects().length)
      trigger.current.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  return { trigger, close };
}
