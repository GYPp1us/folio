import http from "node:http";
import type { Socket } from "node:net";
import { config } from "./config.ts";

export const gatewayUrl =
  process.env.REPORT_GATEWAY_URL || "http://127.0.0.1:8124";
export async function gateway(action: string, body: unknown) {
  const response = await fetch(new URL(action, gatewayUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  const result = (await response.json()) as any;
  if (!response.ok) throw new Error(result.error || "发布网关不可用");
  return result;
}
export function tunnel(id: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL("/" + id, gatewayUrl), {
      method: "CONNECT",
      agent: false,
      headers: { authorization: `Bearer ${config.token}` },
    });
    req.setTimeout(15000, () => req.destroy(new Error("发布服务连接超时")));
    req.on("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error("发布服务已停止或不可用"));
        return;
      }
      req.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.on("error", () => reject(new Error("发布网关连接失败")));
    req.end();
  });
}
