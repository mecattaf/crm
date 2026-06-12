import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://crm.test";
const ADMIN = { email: "admin@sodimo.eu", password: "changeme-sodimo" };

function setCookieHeader(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

/** Extract the crm_session token value from a Set-Cookie header ("" if cleared/absent). */
function sessionToken(res: Response): string {
  const m = setCookieHeader(res).match(/crm_session=([^;]*)/);
  return m?.[1] ?? "";
}

async function loginForm(
  fields: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`${BASE}/login`, {
    method: "POST",
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

async function loginAdmin(): Promise<string> {
  const res = await loginForm(ADMIN);
  const token = sessionToken(res);
  expect(token).not.toBe("");
  return token;
}

async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("HTML login/logout", () => {
  it("GET /login renders the form", async () => {
    const res = await SELF.fetch(`${BASE}/login`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="email"');
    expect(body).toContain('name="password"');
  });

  it("successful login sets a hardened cookie and redirects to /", async () => {
    const res = await loginForm(ADMIN);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = setCookieHeader(res);
    expect(cookie).toContain("crm_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("honors a safe ?next target and rejects external ones", async () => {
    const ok = await loginForm({ ...ADMIN, next: "/deals?view=board" });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/deals?view=board");

    const evil = await loginForm({ ...ADMIN, next: "https://evil.example/" });
    expect(evil.status).toBe(302);
    expect(evil.headers.get("location")).toBe("/");

    const schemeless = await loginForm({ ...ADMIN, next: "//evil.example/" });
    expect(schemeless.headers.get("location")).toBe("/");
  });

  it("wrong password returns 401, shows the error, sets no cookie", async () => {
    const res = await loginForm({ email: ADMIN.email, password: "nope" });
    expect(res.status).toBe(401);
    expect(setCookieHeader(res)).toBe("");
    expect(await res.text()).toContain("Invalid email or password.");
  });

  it("unknown email fails identically (no user enumeration)", async () => {
    const res = await loginForm({ email: "ghost@sodimo.eu", password: "nope" });
    expect(res.status).toBe(401);
    expect(setCookieHeader(res)).toBe("");
  });

  it("POST /logout destroys the session and clears the cookie", async () => {
    const token = await loginAdmin();
    const out = await SELF.fetch(`${BASE}/logout`, {
      method: "POST",
      headers: { Cookie: `crm_session=${token}` },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login");
    expect(setCookieHeader(out)).toMatch(/crm_session=;|crm_session=""/);

    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(me.status).toBe(401);
  });
});

describe("JSON auth API", () => {
  it("POST /api/auth/login returns the user and sets the cookie", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN),
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: Record<string, unknown> };
    expect(user["id"]).toBe(1);
    expect(user["email"]).toBe(ADMIN.email);
    expect(user["role"]).toBe("admin");
    expect(user["password_hash"]).toBeUndefined();
    expect(sessionToken(res)).not.toBe("");
  });

  it("POST /api/auth/login with bad credentials → 401, no cookie", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN.email, password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "invalid_credentials" });
    expect(setCookieHeader(res)).toBe("");
  });

  it("GET /api/auth/me with a valid cookie returns the user", async () => {
    const token = await loginAdmin();
    const res = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: Record<string, unknown> };
    expect(user["email"]).toBe(ADMIN.email);
  });

  it("GET /api/auth/me without a cookie → 401 unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/me`);
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "unauthenticated" });
  });

  it("POST /api/auth/logout invalidates the session server-side", async () => {
    const token = await loginAdmin();
    const out = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(out.status).toBe(200);

    const me = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(me.status).toBe(401);
  });
});

describe("session expiry", () => {
  it("an expired session row is rejected and lazily deleted", async () => {
    const token = "expired-token-fixture";
    const id = await sha256hex(token);
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)",
    )
      .bind(id, "2020-01-01T00:00:00.000Z", "2019-12-02T00:00:00.000Z")
      .run();

    const res = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(401);

    const row = await env.DB.prepare("SELECT id FROM sessions WHERE id = ?").bind(id).first();
    expect(row).toBeNull();
  });

  it("a directly inserted unexpired session is accepted", async () => {
    const token = "valid-token-fixture";
    const id = await sha256hex(token);
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 1, ?, ?)",
    )
      .bind(id, "2099-01-01T00:00:00.000Z", "2026-06-12T00:00:00.000Z")
      .run();

    const res = await SELF.fetch(`${BASE}/api/auth/me`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("API guard coverage", () => {
  it("/api/health stays open", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ ok: true });
  });

  it("a protected /api route 401s without a cookie", async () => {
    const res = await SELF.fetch(`${BASE}/api/organizations`);
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "unauthenticated" });
  });

  it("the same route passes the guard with a cookie", async () => {
    const token = await loginAdmin();
    const res = await SELF.fetch(`${BASE}/api/organizations`, {
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(200);
  });
});
