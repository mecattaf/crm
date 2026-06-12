import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Hono } from "hono";
import { type AppEnv, requireSession } from "./auth/middleware";
import { authApi, authPages } from "./auth/routes";

/**
 * Identity attached to every OAuth grant at /authorize consent
 * (completeAuthorization props) and delivered to tool handlers as
 * `this.props` on every authorized /mcp request.
 */
export type Props = { userId: number; role: string };

/**
 * The CRM MCP agent (SQLite-backed Durable Object, per-session and
 * disposable — D1 is the only source of truth). Tools are registered in
 * issue #5 and read the acting user from `this.props`.
 */
export class CrmMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "sodimo-crm", version: "0.1.0" });

  async init(): Promise<void> {
    // MCP tools are registered here in issue #5.
  }
}

// OAuthProvider injects env.OAUTH_PROVIDER (OAuthHelpers) before invoking us.
const app = new Hono<AppEnv>();

// Session guard for the REST API; /api/health and /api/auth/* stay open.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path.startsWith("/api/auth/")) return next();
  return requireSession(c, next);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authApi);

// /login, /logout, /authorize (OAuth consent reusing the GUI session)
app.route("/", authPages);

// Entry composition (SPEC.md): the OAuthProvider owns /token, /register and
// /.well-known/*, verifies bearer tokens for /mcp (handing the grant's props
// to CrmMCP), and forwards everything else to the Hono app.
export default new OAuthProvider({
  apiHandlers: { "/mcp": CrmMCP.serve("/mcp") },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
