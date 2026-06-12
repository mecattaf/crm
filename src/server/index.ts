import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Hono } from "hono";

/**
 * The CRM MCP agent (SQLite-backed Durable Object, per-session and
 * disposable — D1 is the only source of truth).
 *
 * Tools are registered in issue #5; OAuth wiring (OAuthProvider wrapping
 * `CrmMCP.serve("/mcp")` + this Hono app as defaultHandler) is issue #6.
 */
export class CrmMCP extends McpAgent<Env> {
  server = new McpServer({ name: "sodimo-crm", version: "0.1.0" });

  async init(): Promise<void> {
    // MCP tools are registered here in issue #5.
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

// Issue #6 replaces this default export with the OAuthProvider composition
// described in SPEC.md (apiHandlers["/mcp"] = CrmMCP.serve("/mcp"),
// defaultHandler = app).
export default app;
