import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TouchEvent,
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
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart(event: TouchEvent<HTMLElement>) {
      start.current = null;
      if (
        !enabled ||
        event.touches.length !== 1 ||
        !(event.target instanceof Element)
      )
        return;
      const target = event.target;
      if (
        !target.closest(".conversation-window, .topbar") ||
        target.closest(
          "button, a, input, textarea, select, summary, mark, pre, table, iframe, img, [contenteditable], [role=button]",
        )
      )
        return;
      const touch = event.touches[0];
      // Leave system navigation at the screen edges to the OS.
      if (touch.clientX < 24 || touch.clientX > innerWidth - 24) return;
      start.current = { x: touch.clientX, y: touch.clientY };
    },
    onTouchEnd(event: TouchEvent<HTMLElement>) {
      const origin = start.current;
      start.current = null;
      if (
        !enabled ||
        !origin ||
        event.touches.length ||
        !event.changedTouches.length ||
        window.getSelection()?.isCollapsed === false
      )
        return;
      const touch = event.changedTouches[0];
      const distance = origin.x - touch.clientX;
      if (distance >= 60 && distance > Math.abs(origin.y - touch.clientY) * 1.7)
        open();
    },
    onTouchCancel() {
      start.current = null;
    },
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
