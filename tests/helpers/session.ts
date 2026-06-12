import { SELF } from "cloudflare:test";

/**
 * Session plumbing for REST integration tests: log in as the seeded admin via
 * the JSON auth API and replay the session cookie on every request. Sessions
 * are wiped by tests/setup.ts beforeEach, so call loginCookie() per test (a
 * beforeEach in the test file runs after the global reset).
 */
export const BASE = "https://crm.test";

const ADMIN = { email: "admin@sodimo.eu", password: "changeme-sodimo" };

/** POST /api/auth/login; returns the Cookie header value for apiFetch. */
export async function loginCookie(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (res.status !== 200) throw new Error(`admin login failed with ${res.status}`);
  const token = (res.headers.get("set-cookie") ?? "").match(/crm_session=([^;]*)/)?.[1];
  if (!token) throw new Error("login set no crm_session cookie");
  return `crm_session=${token}`;
}

/** Authenticated JSON request against the /api surface. */
export async function apiFetch(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      Cookie: cookie,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** apiFetch + status assertion + parsed JSON body. */
export async function apiJson<T>(
  cookie: string,
  method: string,
  path: string,
  body: unknown,
  expectStatus: number,
): Promise<T> {
  const res = await apiFetch(cookie, method, path, body);
  if (res.status !== expectStatus) {
    throw new Error(
      `${method} ${path}: expected ${expectStatus}, got ${res.status}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
}
