/**
 * DB-backed sessions referenced by an HttpOnly cookie.
 *
 * The cookie carries a random 256-bit token (base64url); the `sessions` table
 * stores only its SHA-256 hex hash as `id`, so a DB leak reveals no usable
 * tokens. No signing secret is needed — the token itself is the secret.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { schema } from "../db";

export const SESSION_COOKIE = "crm_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Cookie attributes shared by the HTML and JSON login paths. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
} as const;

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: "admin" | "member";
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create a session row; returns the raw token (for the cookie) and expiry. */
export async function createSession(
  db: Db,
  userId: number,
  now?: string,
): Promise<{ token: string; expires_at: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const created_at = nowIso(now);
  const expires_at = new Date(Date.parse(created_at) + SESSION_TTL_SECONDS * 1000).toISOString();
  await db.insert(schema.sessions).values({
    id: await hashToken(token),
    user_id: userId,
    expires_at,
    created_at,
  });
  return { token, expires_at };
}

/** Resolve a cookie token to its user; null if unknown, expired, or user archived. */
export async function validateSession(
  db: Db,
  token: string,
  now?: string,
): Promise<SessionUser | null> {
  if (!token) return null;
  const id = await hashToken(token);
  const row = await db
    .select({
      expires_at: schema.sessions.expires_at,
      user_id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
      archived_at: schema.users.archived_at,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.user_id, schema.users.id))
    .where(eq(schema.sessions.id, id))
    .get();
  if (!row) return null;
  if (row.expires_at <= nowIso(now)) {
    // lazy cleanup of the expired row
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  if (row.archived_at) return null;
  return { id: row.user_id, email: row.email, name: row.name, role: row.role };
}

/** Delete the session row for a cookie token (logout). Idempotent. */
export async function destroySession(db: Db, token: string): Promise<void> {
  if (!token) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.id, await hashToken(token)));
}
