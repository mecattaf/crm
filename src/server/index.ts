import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { api } from "./api/router";
import { type AppEnv, requireSession } from "./auth/middleware";
import { authApi, authPages } from "./auth/routes";
import { CrmMCP } from "./mcp";

// The MCP agent (Durable Object class) + its OAuth Props live in ./mcp.
export { CrmMCP } from "./mcp";
export type { Props } from "./mcp";

// OAuthProvider injects env.OAUTH_PROVIDER (OAuthHelpers) before invoking us.
const app = new Hono<AppEnv>();

// Session guard for the REST API; /api/health and /api/auth/* stay open.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || c.req.path.startsWith("/api/auth/")) return next();
  return requireSession(c, next);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authApi);
app.route("/api", api);

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
