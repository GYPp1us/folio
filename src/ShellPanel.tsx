import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Modal } from "./ui";

export function ShellPanel({
  repo,
  onClose,
}: {
  repo: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="沙箱 Shell"
      description={`${repo} · /work`}
      wide
    >
      <Shell repo={repo} />
    </Modal>
  );
}
function Shell({ repo }: { repo: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("正在连接…"),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!root.current) return;
    const terminal = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: "#252521",
        foreground: "#eee9df",
        cursor: "#d6a184",
        selectionBackground: "#615245",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(root.current);
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/shell/${encodeURIComponent(repo)}`,
    );
    ws.binaryType = "arraybuffer";
    const resize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ cols: terminal.cols, rows: terminal.rows }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root.current);
    const frame = requestAnimationFrame(resize);
    const input = terminal.onData((input) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ input }));
    });
    ws.onopen = () => {
      setStatus("已连接");
      resize();
      terminal.focus();
    };
    ws.onmessage = (e) =>
      terminal.write(
        typeof e.data === "string" ? e.data : new Uint8Array(e.data),
      );
    ws.onerror = () => setStatus("连接失败，请检查登录和沙箱状态");
    ws.onclose = () => setStatus("已断开");
    return () => {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [repo, generation]);
  return (
    <>
      <div className="shell-toolbar">
        <span>{status}</span>
        <button
          className="text-button"
          onClick={() => {
            setStatus("正在连接…");
            setGeneration((x) => x + 1);
          }}
        >
          重连
        </button>
      </div>
      <div className="shell-terminal" ref={root} />
      <p className="muted">
        直接操作当前沙箱；关闭窗口会结束此 Shell。Ctrl+C 中断当前命令。
      </p>
    </>
  );
}
