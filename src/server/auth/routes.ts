/**
 * Auth surfaces:
 *  - HTML: GET/POST /login, POST /logout, GET/POST /authorize (OAuth consent)
 *  - JSON (SPA): POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
 *
 * Both share the same DB sessions and `crm_session` cookie.
 *
 * Brute-force posture (documented decision): per-email attempt counters in
 * Worker memory are useless (isolates are ephemeral and unshared) and a
 * KV/D1-backed rate limiter is overkill for a 5-user tool. Instead, every
 * failed login costs a full constant-time PBKDF2 verification (a dummy hash
 * is verified when the email is unknown, so timing does not leak user
 * existence) plus a 300ms artificial delay.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb, schema, type Db } from "../db";
import { type AppEnv, requireSession } from "./middleware";
import { consentPage, errorPage, loginPage } from "./pages";
import { verifyPassword } from "./passwords";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type SessionUser,
  createSession,
  destroySession,
  validateSession,
} from "./sessions";

const FAILED_LOGIN_DELAY_MS = 300;

// Well-formed PBKDF2 hash (all-zero salt/digest) verified when the email is
// unknown, so unknown-email and wrong-password paths cost the same.
const DUMMY_HASH = `pbkdf2-sha256$600000$${"A".repeat(22)}==$${"A".repeat(43)}=`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Verify email+password against users; constant-cost on all failure paths. */
async function authenticate(db: Db, email: string, password: string): Promise<SessionUser | null> {
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!ok || !user || user.archived_at) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Only allow same-origin relative redirect targets (no open redirect). */
function safeNext(next: unknown): string | undefined {
  if (typeof next !== "string" || next === "") return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  return next;
}

function formString(form: Record<string, unknown>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

// base64url round-trip of the parsed AuthRequest through the consent form.
function encodeAuthRequest(req: AuthRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeAuthRequest(encoded: string): AuthRequest | null {
  try {
    const bin = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as AuthRequest).clientId !== "string" ||
      typeof (parsed as AuthRequest).redirectUri !== "string"
    ) {
      return null;
    }
    return parsed as AuthRequest;
  } catch {
    return null;
  }
}

async function sessionUser(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return validateSession(createDb(c.env.DB), token);
}

// ---------------------------------------------------------------------------
// HTML pages (login / logout / OAuth consent)
// ---------------------------------------------------------------------------

export const authPages = new Hono<AppEnv>();

authPages.get("/login", async (c) => {
  const next = safeNext(c.req.query("next"));
  const user = await sessionUser(c);
  if (user) return c.redirect(next ?? "/", 302);
  return c.html(loginPage({ ...(next !== undefined && { next }) }));
});

authPages.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = formString(form, "email").trim().toLowerCase();
  const password = formString(form, "password");
  const next = safeNext(formString(form, "next"));

  const db = createDb(c.env.DB);
  const user = email && password ? await authenticate(db, email, password) : null;
  if (!user) {
    await delay(FAILED_LOGIN_DELAY_MS);
    return c.html(
      loginPage({ error: "Invalid email or password.", email, ...(next !== undefined && { next }) }),
      401,
    );
  }
  const { token } = await createSession(db, user.id);
  setCookie(c, SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
  return c.redirect(next ?? "/", 302);
});

authPages.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(createDb(c.env.DB), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/login", 302);
});

// OAuth consent screen. GET renders approve/deny; POST completes the grant.
// CSRF posture: the session cookie is SameSite=Lax, so cross-site POSTs do
// not carry it; the AuthRequest is round-tripped via hidden field as in the
// workers-oauth-provider reference flow.
authPages.get("/authorize", async (c) => {
  const user = await sessionUser(c);
  if (!user) {
    const url = new URL(c.req.url);
    const next = encodeURIComponent(url.pathname + url.search);
    return c.redirect(`/login?next=${next}`, 302);
  }
  let oauthReq: AuthRequest;
  try {
    oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    return c.html(errorPage(`Invalid authorization request: ${(e as Error).message}`), 400);
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return c.html(errorPage("Unknown OAuth client."), 400);
  return c.html(
    consentPage({
      clientName: client.clientName ?? client.clientId,
      scopes: oauthReq.scope,
      oauthReq: encodeAuthRequest(oauthReq),
      userEmail: user.email,
    }),
  );
});

authPages.post("/authorize", async (c) => {
  const user = await sessionUser(c);
  if (!user) return c.redirect("/login", 302);

  const form = await c.req.parseBody();
  const oauthReq = decodeAuthRequest(formString(form, "oauth_req"));
  if (!oauthReq) return c.html(errorPage("Malformed authorization form."), 400);

  if (formString(form, "decision") !== "approve") {
    const back = new URL(oauthReq.redirectUri);
    back.searchParams.set("error", "access_denied");
    if (oauthReq.state) back.searchParams.set("state", oauthReq.state);
    return c.redirect(back.toString(), 302);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: String(user.id),
    metadata: { email: user.email },
    scope: oauthReq.scope,
    // Arrives in MCP tools as this.props (end-to-end encrypted by the lib).
    props: { userId: user.id, role: user.role },
  });
  return c.redirect(redirectTo, 302);
});

// ---------------------------------------------------------------------------
// JSON API for the SPA (cookie-based, same sessions)
// ---------------------------------------------------------------------------

export const authApi = new Hono<AppEnv>();

authApi.post("/login", async (c) => {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const db = createDb(c.env.DB);
  const user = email && password ? await authenticate(db, email, password) : null;
  if (!user) {
    await delay(FAILED_LOGIN_DELAY_MS);
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const { token } = await createSession(db, user.id);
  setCookie(c, SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
  return c.json({ user });
});

authApi.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(createDb(c.env.DB), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

authApi.get("/me", requireSession, (c) => c.json({ user: c.var.user }));
