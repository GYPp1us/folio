import { makeSandboxSpawner } from "./sandbox.ts";
import { claudeEnv } from "./auth-config.ts";
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const WRITE_FILE_SCRIPT = `# folio-safe-write-v1
import os,sys
parts=sys.argv[1].split('/')
if parts[:2]!=['','work'] or any(x in ('','.','..') for x in parts[2:]): raise ValueError('Invalid workspace path')
fd=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:-1]:
  try: os.mkdir(part,0o700,dir_fd=fd)
  except FileExistsError: pass
  next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=next_fd
 try: out=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 except FileExistsError:
  import hashlib
  inp=sys.stdin.buffer.read(${MAX_ASSET_BYTES}+1)
  current=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  with os.fdopen(current,'rb') as f: existing=f.read(${MAX_ASSET_BYTES}+1)
  if inp!=existing: raise ValueError('Staged content mismatch')
 else:
  with os.fdopen(out,'wb') as f:
   size=0
   while True:
    chunk=sys.stdin.buffer.read(65536)
    if not chunk: break
    size+=len(chunk)
    if size>${MAX_ASSET_BYTES}: raise ValueError('File too large')
    f.write(chunk)
   os.fchmod(f.fileno(),0o400)
finally: os.close(fd)
`;
export const READ_FILE_SCRIPT = `# folio-safe-read-v1
import os,sys,stat
parts=sys.argv[1].split('/')
if parts[:2]!=['','work'] or any(x in ('','.','..') for x in parts[2:]): raise ValueError('Invalid workspace path')
fd=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[2:-1]:
  next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd); os.close(fd); fd=next_fd
 source=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(source,'rb') as f:
  info=os.fstat(f.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_size>${MAX_ASSET_BYTES}: raise ValueError('Not a regular bounded file')
  data=f.read(${MAX_ASSET_BYTES}+1)
  if len(data)>${MAX_ASSET_BYTES}: raise ValueError('File too large')
  sys.stdout.buffer.write(data)
finally: os.close(fd)
`;
export interface FileBridge {
  write(repo: string, path: string, bytes: Buffer): Promise<void>;
  read(repo: string, path: string): Promise<Buffer>;
}
export class SandboxFiles implements FileBridge {
  private async execute(
    repo: string,
    script: string,
    path: string,
    input?: Buffer,
  ): Promise<Buffer> {
    if (
      !path.startsWith("/work/") ||
      path.split("/").some((p) => p === ".." || p === ".") ||
      path.includes("\x00")
    )
      throw new Error("只能访问当前工作区中的普通文件");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 45000);
    try {
      const p = makeSandboxSpawner(repo)({
        command: "python3",
        args: ["-c", script, path],
        cwd: "/work",
        env: claudeEnv(repo),
        signal: controller.signal,
      });
      const chunks: Buffer[] = [];
      let total = 0;
      p.stdout.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_ASSET_BYTES) controller.abort();
        else chunks.push(Buffer.from(chunk));
      });
      const exit = new Promise<number | null>((resolve) =>
        p.on("exit", resolve),
      );
      p.stdin.end(input || Buffer.alloc(0));
      if ((await exit) !== 0)
        throw new Error("沙箱文件读写失败：路径、权限或文件大小不符合要求。");
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async write(repo: string, path: string, bytes: Buffer) {
    await this.execute(repo, WRITE_FILE_SCRIPT, path, bytes);
  }
  read(repo: string, path: string) {
    return this.execute(repo, READ_FILE_SCRIPT, path);
  }
}
