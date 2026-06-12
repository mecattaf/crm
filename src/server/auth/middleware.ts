import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db";
import { SESSION_COOKIE, type SessionUser, validateSession } from "./sessions";

/**
 * Hono env shared by the whole default handler. OAUTH_PROVIDER is injected
 * into env by the wrapping OAuthProvider; `user` is set by `requireSession`.
 */
export type AppEnv = {
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
  Variables: { user: SessionUser };
};

/**
 * Session-cookie guard for API routes: resolves the `crm_session` cookie to a
 * user and sets `c.var.user`, or responds 401 {error:"unauthenticated"}.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await validateSession(createDb(c.env.DB), token) : null;
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  await next();
});
