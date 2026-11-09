import type { FastifyInstance } from "fastify";
import { makeSandboxSpawner, sandbox } from "./sandbox.ts";

// PTY ownership stays inside the sandbox. EOF/closing the browser reaps its process group.
export const PTY_SCRIPT = `import os,sys,pty,select,subprocess,signal,json,fcntl,termios,struct,time
master,slave=pty.openpty()
def child():
 os.setsid(); fcntl.ioctl(slave,termios.TIOCSCTTY,0)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/home/ccuser','TERM':'xterm-256color','LANG':'C.UTF-8'}
p=subprocess.Popen(['bash','--noprofile','--norc','-i'],stdin=slave,stdout=slave,stderr=slave,cwd='/work',env=env,preexec_fn=child)
os.close(slave); buf=b''
try:
 while p.poll() is None:
  ready,_,_=select.select([master,sys.stdin.buffer],[],[],2)
  if sys.stdin.buffer in ready:
   data=os.read(sys.stdin.fileno(),65536)
   if not data: break
   buf+=data
   while b'\\n' in buf:
    line,buf=buf.split(b'\\n',1)
    try:
     msg=json.loads(line)
     if 'input' in msg: os.write(master,msg['input'].encode())
     if 'cols' in msg: fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',max(1,min(200,int(msg.get('rows',24)))),max(2,min(400,int(msg['cols']))),0,0))
    except (ValueError,KeyError,TypeError): pass
  if master in ready:
   try: data=os.read(master,65536)
   except OSError: break
   if not data: break
   os.write(sys.stdout.fileno(),data)
finally:
 try: os.killpg(p.pid,signal.SIGHUP)
 except ProcessLookupError: pass
 try: p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  p.wait()
 os.close(master)
`;

export function registerShell(app: FastifyInstance) {
  let count = 0;
  app.get<{ Params: { repo: string } }>(
    "/api/shell/:repo",
    { websocket: true },
    (ws, req) => {
      const repo = req.params.repo;
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(repo) || count >= 4) {
        ws.close(1008, "Shell unavailable");
        return;
      }
      count++;
      const controller = new AbortController();
      let proc: ReturnType<ReturnType<typeof makeSandboxSpawner>> | undefined;
      let closed = false;
      const timer = setTimeout(
        () => ws.close(1000, "Shell session expired"),
        2 * 3600000,
      );
      const finish = () => {
        if (closed) return;
        closed = true;
        count--;
        clearTimeout(timer);
        // EOF lets the PTY wrapper reap its children before ending the exec stream.
        proc?.stdin.end();
        const cleanup = setTimeout(() => controller.abort(), 3500);
        cleanup.unref();
      };
      const queue: string[] = [];
      ws.on("message", (raw) => {
        if (closed || proc?.stdin.destroyed) return;
        if (Buffer.byteLength(raw.toString()) > 65536) return ws.close(1009);
        try {
          const data = JSON.parse(raw.toString());
          const message =
            JSON.stringify({
              ...(typeof data.input === "string" ? { input: data.input } : {}),
              ...(Number.isInteger(data.cols)
                ? {
                    cols: data.cols,
                    rows: Number.isInteger(data.rows) ? data.rows : 24,
                  }
                : {}),
            }) + "\n";
          if (proc) proc.stdin.write(message);
          else if (queue.length < 16) queue.push(message);
        } catch {
          ws.close(1008);
        }
      });
      ws.on("close", finish);
      ws.on("error", finish);
      void (async () => {
        await sandbox("/sandbox/start", "POST", { repo });
        if (closed) return;
        proc = makeSandboxSpawner(repo)({
          command: "python3",
          args: ["-u", "-c", PTY_SCRIPT],
          cwd: "/work",
          env: {},
          signal: controller.signal,
        });
        proc.stdin.on("error", () => ws.close(1011));
        proc.stdout.on("data", (chunk) => {
          if (ws.readyState === 1) {
            if (ws.bufferedAmount > 2 * 1024 * 1024) ws.close(1009);
            else ws.send(chunk, { binary: true });
          }
        });
        proc.on("exit", () => ws.close(1000));
        for (const message of queue) proc.stdin.write(message);
      })().catch(() => {
        if (ws.readyState === 1) ws.send("\r\n无法连接沙箱 Shell。\r\n");
        ws.close(1011);
      });
    },
  );
}
