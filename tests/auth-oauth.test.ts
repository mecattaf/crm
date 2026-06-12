import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://crm.test";
const REDIRECT_URI = "https://client.example/callback";

async function loginAdmin(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/login`, {
    method: "POST",
    body: new URLSearchParams({ email: "admin@sodimo.eu", password: "changeme-sodimo" }),
    redirect: "manual",
  });
  const token = (res.headers.get("set-cookie") ?? "").match(/crm_session=([^;]*)/)?.[1] ?? "";
  expect(token).not.toBe("");
  return token;
}

/** Dynamic client registration (RFC 7591) against the provider's /register. */
async function registerClient(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "Test MCP Client",
      token_endpoint_auth_method: "none", // public client + PKCE, like claude.ai
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  expect(body.client_id).toBeTypeOf("string");
  return body.client_id;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function authorizeUrl(clientId: string, challenge: string): string {
  const url = new URL(`${BASE}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "profile");
  url.searchParams.set("state", "state-xyz");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

describe("OAuth metadata + consent", () => {
  it("serves RFC 8414 authorization server metadata", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, string>;
    expect(meta["authorization_endpoint"]).toBe(`${BASE}/authorize`);
    expect(meta["token_endpoint"]).toBe(`${BASE}/token`);
    expect(meta["registration_endpoint"]).toBe(`${BASE}/register`);
  });

  it("GET /authorize without a session redirects to /login?next=<original url>", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const res = await SELF.fetch(authorizeUrl(clientId, challenge), { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login?next=")).toBe(true);
    const next = decodeURIComponent(location.slice("/login?next=".length));
    expect(next).toContain("/authorize?");
    expect(next).toContain(`client_id=${clientId}`);
  });

  it("GET /authorize with a session renders the consent screen", async () => {
    const session = await loginAdmin();
    const clientId = await registerClient();
    const { challenge } = await pkcePair();
    const res = await SELF.fetch(authorizeUrl(clientId, challenge), {
      headers: { Cookie: `crm_session=${session}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test MCP Client");
    expect(html).toContain("profile"); // requested scope listed
    expect(html).toContain('name="decision" value="approve"');
    expect(html).toContain('name="decision" value="deny"');
  });

  it("GET /authorize with an unknown client renders an error", async () => {
    const session = await loginAdmin();
    const { challenge } = await pkcePair();
    const res = await SELF.fetch(authorizeUrl("not-a-client", challenge), {
      headers: { Cookie: `crm_session=${session}` },
    });
    expect(res.status).toBe(400);
    // parseAuthRequest validates the client itself and throws "Invalid client"
    expect(await res.text()).toContain("Invalid client");
  });
});

describe("full authorization-code + PKCE flow (DCR client)", () => {
  it("approve → code → token exchange returns an access token", async () => {
    const session = await loginAdmin();
    const clientId = await registerClient();
    const { verifier, challenge } = await pkcePair();

    // 1. consent screen carries the round-tripped AuthRequest
    const consent = await SELF.fetch(authorizeUrl(clientId, challenge), {
      headers: { Cookie: `crm_session=${session}` },
    });
    expect(consent.status).toBe(200);
    const oauthReq = (await consent.text()).match(/name="oauth_req" value="([^"]+)"/)?.[1];
    expect(oauthReq).toBeTypeOf("string");

    // 2. approve → redirect back to the client with code + state
    const approve = await SELF.fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { Cookie: `crm_session=${session}` },
      body: new URLSearchParams({ oauth_req: oauthReq as string, decision: "approve" }),
      redirect: "manual",
    });
    expect(approve.status).toBe(302);
    const back = new URL(approve.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    expect(back.searchParams.get("state")).toBe("state-xyz");
    const code = back.searchParams.get("code");
    expect(code).toBeTypeOf("string");

    // 3. token exchange with the PKCE verifier
    const tokenRes = await SELF.fetch(`${BASE}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as Record<string, unknown>;
    expect(tokens["token_type"]).toBe("bearer");
    expect(tokens["access_token"]).toBeTypeOf("string");
    expect(tokens["refresh_token"]).toBeTypeOf("string");

    // 4. the access token authorizes /mcp (CrmMCP receives this grant's
    //    props as this.props); a garbage token is rejected by the provider
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    };
    const mcpHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const authorized = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, Authorization: `Bearer ${tokens["access_token"] as string}` },
      body: JSON.stringify(initialize),
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toContain('"serverInfo"');

    const unauthorized = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, Authorization: "Bearer garbage" },
      body: JSON.stringify(initialize),
    });
    expect(unauthorized.status).toBe(401);
  });

  it("deny redirects back with error=access_denied", async () => {
    const session = await loginAdmin();
    const clientId = await registerClient();
    const { challenge } = await pkcePair();

    const consent = await SELF.fetch(authorizeUrl(clientId, challenge), {
      headers: { Cookie: `crm_session=${session}` },
    });
    const oauthReq = (await consent.text()).match(/name="oauth_req" value="([^"]+)"/)?.[1];

    const deny = await SELF.fetch(`${BASE}/authorize`, {
      method: "POST",
      headers: { Cookie: `crm_session=${session}` },
      body: new URLSearchParams({ oauth_req: oauthReq as string, decision: "deny" }),
      redirect: "manual",
    });
    expect(deny.status).toBe(302);
    const back = new URL(deny.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("state-xyz");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("POST /authorize without a session redirects to /login", async () => {
    const res = await SELF.fetch(`${BASE}/authorize`, {
      method: "POST",
      body: new URLSearchParams({ oauth_req: "abc", decision: "approve" }),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
