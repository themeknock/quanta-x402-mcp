/**
 * MCP over HTTP, stateless, on the official SDK.
 *
 * Cloudflare's usual route to a remote MCP server is the `agents` package's
 * McpAgent, which keeps a session in a Durable Object. This service does not need
 * one: every call carries its own payment, so there is nothing to remember
 * between requests. Staying stateless keeps it on the free plan and means no
 * session pins an agent to one machine.
 *
 * What is hand-written here is ~40 lines of transport, not the protocol. The
 * SDK's `Server` still does the schema validation, the capability negotiation and
 * the error codes; this just feeds it one JSON-RPC message per HTTP request and
 * collects the reply. The SDK's own transports are Node-flavoured (`node:http`,
 * `node:process`), which is the only reason they are not used directly.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

import type { Env, Settings } from "./config";
import { TOOL_DEFINITIONS, runTool } from "./tools";

/** Feeds one JSON-RPC message in, resolves with the one that comes back out. */
class OneShotTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private settle!: (message: JSONRPCMessage | null) => void;
  readonly reply: Promise<JSONRPCMessage | null>;

  constructor() {
    this.reply = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.settle(message);
  }

  async close(): Promise<void> {
    this.settle(null);
    this.onclose?.();
  }
}

function buildServer(env: Env, settings: Settings): Server {
  const server = new Server(
    { name: "Quanta", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const body = await runTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      env,
      settings,
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
  });

  return server;
}

export async function handleMcp(request: Request, env: Env, settings: Settings): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated stream in a stateless server: there is no session to
    // push anything to. Say so plainly rather than hanging an SSE open.
    return json(
      {
        jsonrpc: "2.0",
        error: { code: -32601, message: "This MCP endpoint is stateless; POST JSON-RPC requests to it." },
        id: null,
      },
      405,
    );
  }
  if (request.method === "DELETE") {
    return new Response(null, { status: 204 }); // nothing to tear down
  }

  let message: JSONRPCMessage;
  try {
    message = (await request.json()) as JSONRPCMessage;
  } catch {
    return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
  }

  const transport = new OneShotTransport();
  const server = buildServer(env, settings);
  await server.connect(transport);

  const isNotification = !("id" in (message as { id?: unknown }));
  transport.onmessage?.(message);

  if (isNotification) {
    // A notification has no reply. 202 is what the streamable-HTTP transport
    // specifies for "accepted, nothing to say".
    return new Response(null, { status: 202 });
  }

  const reply = await transport.reply;
  await server.close().catch(() => {});
  if (!reply) {
    return json(
      { jsonrpc: "2.0", error: { code: -32603, message: "No response produced" }, id: null },
      500,
    );
  }
  return json(reply, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
