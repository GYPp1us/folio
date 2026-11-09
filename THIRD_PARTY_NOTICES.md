# Third-party components and design references

Folio uses the official Anthropic Claude Agent SDK, React, Radix UI, Fastify, Lucide, React Markdown, remark-gfm, Zod, parse5, mdast-util-from-markdown Sharp and React Virtuoso (MIT). Their source licenses are distributed in their npm packages. Dependencies and exact versions are recorded in package-lock.json.

The attachment rail, deliverable preview and collapsed execution-detail interactions reference DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness, MIT). Folio adapts those interaction patterns to its own backend and the user's cc-sandbox protocol; it does not include the DSH runtime.

server/sandbox.ts adapts the integration example supplied by the user's sandbox agent. SDK argument arrays are forwarded unchanged.

The windowed conversation uses React Virtuoso (https://github.com/petyosi/react-virtuoso, MIT), with Folio-specific transcript segmentation, tool disclosure state and completion anchoring.

The sandbox terminal uses xterm.js and its Fit addon (https://github.com/xtermjs/xterm.js, MIT). WebSocket transport uses @fastify/websocket (https://github.com/fastify/fastify-websocket, MIT) and ws (https://github.com/websockets/ws, MIT). They are installed from npm with versions pinned in package-lock.json.
