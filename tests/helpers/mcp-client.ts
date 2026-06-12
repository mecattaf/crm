import { SELF } from "cloudflare:test";

/**
 * Real-stack MCP client for tests: completes the full OAuth 2.1 flow (DCR +
 * PKCE, consent as the seeded admin) once, then speaks JSON-RPC over the
 * Streamable HTTP transport at POST /mcp (initialize handshake + session id
 * header per protocol). Create one per test FILE (beforeAll) — the access
 * token lives in KV and the MCP session in the DO, both of which survive the
 * per-test D1 entity resets in tests/setup.ts.
 */

const BASE = "https://crm.test";
const REDIRECT_URI = "https://client.example/callback";
const PROTOCOL_VERSION = "2025-03-26";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown> };
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

export interface McpClient {
  listTools(): Promise<ToolInfo[]>;
  /** raw tools/call result (inspect isError / content / structuredContent) */
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** parsed content[0].text of a SUCCESSFUL call; throws on isError */
  callToolJson<T = Record<string, unknown>>(name: string, args?: Record<string, unknown>): Promise<T>;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function loginAdmin(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/login`, {
    method: "POST",
    body: new URLSearchParams({ email: "admin@sodimo.eu", password: "changeme-sodimo" }),
    redirect: "manual",
  });
  const token = (res.headers.get("set-cookie") ?? "").match(/crm_session=([^;]*)/)?.[1] ?? "";
  if (!token) throw new Error("admin login failed: no crm_session cookie");
  return token;
}

async function registerClient(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "Test MCP Client",
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status !== 201) throw new Error(`client registration failed: ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** DCR + PKCE + consent + token exchange; returns a bearer access token. */
async function obtainAccessToken(): Promise<string> {
  const session = await loginAdmin();
  const clientId = await registerClient();

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));

  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "profile");
  authUrl.searchParams.set("state", "mcp-test");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const consent = await SELF.fetch(authUrl.toString(), {
    headers: { Cookie: `crm_session=${session}` },
  });
  const oauthReq = (await consent.text()).match(/name="oauth_req" value="([^"]+)"/)?.[1];
  if (!oauthReq) throw new Error("consent screen did not include oauth_req");

  const approve = await SELF.fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { Cookie: `crm_session=${session}` },
    body: new URLSearchParams({ oauth_req: oauthReq, decision: "approve" }),
    redirect: "manual",
  });
  const code = new URL(approve.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("approve did not redirect with a code");

  const tokenRes = await SELF.fetch(`${BASE}/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (tokenRes.status !== 200) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { access_token: string };
  return tokens.access_token;
}

/** Streamable HTTP responses arrive as plain JSON or an SSE stream. */
async function readJsonRpcResponse(res: Response, id: number): Promise<JsonRpcMessage> {
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ctype.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const msg = JSON.parse(line.slice(5).trim()) as JsonRpcMessage;
      if (msg.id === id) return msg;
    }
    throw new Error(`no JSON-RPC response with id ${id} in SSE stream:\n${text}`);
  }
  return JSON.parse(text) as JsonRpcMessage;
}

export async function createMcpClient(): Promise<McpClient> {
  const accessToken = await obtainAccessToken();
  let sessionId: string | null = null;
  let nextId = 1;

  async function post(body: unknown): Promise<Response> {
    return SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    if (res.status >= 300) {
      throw new Error(`/mcp ${method} -> HTTP ${res.status}: ${await res.text()}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const message = await readJsonRpcResponse(res, id);
    if (message.error) {
      throw new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`);
    }
    return message.result as T;
  }

  // initialize handshake; the server assigns the session id used afterwards
  await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vitest-mcp-client", version: "0.0.0" },
  });
  if (!sessionId) throw new Error("initialize did not return an mcp-session-id header");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return rpc<ToolResult>("tools/call", { name, arguments: args });
  }

  return {
    async listTools() {
      return (await rpc<{ tools: ToolInfo[] }>("tools/list", {})).tools;
    },
    callTool,
    async callToolJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const result = await callTool(name, args);
      if (result.isError) {
        throw new Error(`tool ${name} returned an error: ${result.content[0]?.text}`);
      }
      return JSON.parse(result.content[0]?.text ?? "null") as T;
    },
  };
}
