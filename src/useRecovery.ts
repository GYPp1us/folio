import { useEffect, useRef, useState } from "react";
declare const __FOLIO_BUILD__: string;
export const disconnected = () =>
  window.dispatchEvent(new Event("folio-disconnected"));
export function useRecovery(options: {
  canReload: boolean;
  onRecovered: (restarted: boolean) => Promise<void>;
  onLocked: () => void;
}) {
  const current = useRef(options);
  current.current = options;
  const [state, setState] = useState<"connected" | "reconnecting" | "locked">(
      "connected",
    ),
    [update, setUpdate] = useState(false);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false,
      busy = false,
      broken = false,
      attempts = 0,
      instance = "",
      timer: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!disposed) timer = setTimeout(() => void probe(), ms);
    };
    const probe = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        const healthResponse = await fetch("/api/health", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (!healthResponse.ok) throw new Error("Unavailable");
        const health = await healthResponse.json();
        if (disposed) return;
        const restarted = !!instance && instance !== health.instance;
        const recover = broken || restarted;
        if (recover) {
          const authResponse = await fetch("/api/auth", {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          if (!authResponse.ok) throw new Error("Authentication unavailable");
          const auth = await authResponse.json();
          if (disposed) return;
          if (auth.required && !auth.loggedIn) {
            current.current.onLocked();
            setState("locked");
            broken = false;
            instance = health.instance;
            schedule(30000);
            return;
          }
        }
        instance = health.instance;
        if (
          import.meta.env.PROD &&
          health.build &&
          health.build !== __FOLIO_BUILD__
        ) {
          setUpdate(true);
          if (current.current.canReload) {
            location.reload();
            return;
          }
        }
        if (recover) {
          await current.current.onRecovered(restarted);
          window.dispatchEvent(
            new CustomEvent("folio-connection-restored", {
              detail: { restarted },
            }),
          );
        }
        broken = false;
        attempts = 0;
        setState("connected");
        schedule(document.hidden ? 60000 : 30000);
      } catch {
        if (disposed) return;
        broken = true;
        setState("reconnecting");
        schedule(Math.min(15000, 1000 * 2 ** Math.min(attempts++, 4)));
      } finally {
        busy = false;
      }
    };
    const lost = () => {
      broken = true;
      setState("reconnecting");
      clearTimeout(timer);
      if (!busy) void probe();
    };
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void probe();
      }
    };
    retry.current = lost;
    window.addEventListener("folio-disconnected", lost);
    window.addEventListener("online", lost);
    window.addEventListener("offline", lost);
    document.addEventListener("visibilitychange", visible);
    void probe();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("folio-disconnected", lost);
      window.removeEventListener("online", lost);
      window.removeEventListener("offline", lost);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  useEffect(() => {
    if (update && options.canReload) location.reload();
  }, [update, options.canReload]);
  return { state, update, retry: () => retry.current() };
}
