import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Store } from "../server/store.ts";
import { Reports } from "../server/reports.ts";
import { testDirectory, startServer } from "./server-helper.ts";

test(
  "服务代理支持 HTTP、SSE 和 WebSocket，凭证不传给应用且目标由发布记录决定",
  { timeout: 20000 },
  async () => {
    const id = randomUUID(),
      received: http.IncomingHttpHeaders[] = [];
    const backend = http.createServer((req, res) => {
      received.push(req.headers);
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        setTimeout(() => res.end("data: second\n\n"), 50);
        return;
      }
      if (req.url === "/api/test") {
        res.setHeader("content-type", "application/json");
        req.pipe(res);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end('<h1>Demo</h1><script src="/app.js"></script>');
    });
    const web = new WebSocketServer({ server: backend });
    web.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendPort = (backend.address() as net.AddressInfo).port;
    const connections = new Set<import("node:stream").Duplex>();
    const bridge = http.createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end('{"state":"running"}');
    });
    bridge.on("connect", (req, socket, head) => {
      assert.equal(req.url, "/" + id);
      assert.equal(req.headers.authorization, "Bearer test-sandbox-token");
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => {});
      const upstream = net.connect(backendPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    });
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const directory = testDirectory(),
      store = new Store(directory),
      reports = new Reports(store),
      session = store.create("proxy-check");
    reports.save({
      id,
      repo: session.repo,
      sessionId: session.id,
      title: "Proxy",
      kind: "service",
      state: "running",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      entry: "index.html",
    });
    store.close();
    const server = await startServer(directory, "", {
      APP_SKIP_SETUP: "1",
      REPORT_GATEWAY_URL: `http://127.0.0.1:${(bridge.address() as net.AddressInfo).port}`,
    });
    try {
      const view = await (
        await fetch(server.base + `/reports/${id}/view`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      const url = server.base.slice(0, -4) + view.src;
      const html = await fetch(url);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /content\/.*\/app.js/);
      const response = await fetch(url + "api/test", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "folio_session=private",
          authorization: "Bearer master-secret",
          origin: "null",
        },
        body: '{"ok":true}',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(received.at(-1)?.cookie, undefined);
      assert.equal(received.at(-1)?.authorization, undefined);
      const sse = await fetch(url + "events");
      assert.match(sse.headers.get("content-type")!, /text\/event-stream/);
      assert.equal(await sse.text(), "data: first\n\ndata: second\n\n");
      const ws = new WebSocket(url.replace(/^http/, "ws") + "echo", {
        origin: "null",
      });
      await new Promise<void>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("open", () => ws.send("hello"));
        ws.on("message", (data) => {
          assert.equal(data.toString(), "hello");
          ws.close();
          resolve();
        });
      });
      await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    } finally {
      await server.stop();
      for (const connection of connections) connection.destroy();
      for (const ws of web.clients) ws.terminate();
      web.close();
      backend.closeAllConnections();
      backend.close();
      bridge.closeAllConnections();
      bridge.close();
    }
  },
);
