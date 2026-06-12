# crm

MCP-native CRM for Sodimo on Cloudflare Workers + D1.

- Primary interface: remote MCP server at `/mcp` (Streamable HTTP, OAuth 2.1)
- Secondary: React SPA served from the same Worker
- See [SPEC.md](SPEC.md) for the full specification.

## Auth

- GUI/REST: email+password against D1 `users` (PBKDF2-SHA256, 600k iterations,
  WebCrypto) → DB-backed session referenced by an HttpOnly `crm_session`
  cookie (Secure, SameSite=Lax, 30-day expiry; only the token's SHA-256 hash
  is stored).
- MCP: `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR) at
  `/authorize`, `/token`, `/register`; the consent screen reuses the GUI
  session and attaches `props = { userId, role }` to each grant.
- Login brute-force posture: no per-email rate limiter (in-memory counters
  are meaningless across Worker isolates; a KV/D1 limiter is overkill for 5
  users). Every failed login costs a full constant-time PBKDF2 verification
  (a dummy hash is verified for unknown emails, so timing does not reveal
  user existence) plus a 300ms artificial delay.

## Deployment secrets

None. No `wrangler secret put` is required: session tokens are random
bearer secrets hashed into D1 (no signing key), and the OAuth provider
encrypts grant `props` with token-derived key material in `OAUTH_KV` (no
`COOKIE_SECRET`-style variable). Only the bindings in `wrangler.jsonc`
(`DB`, `OAUTH_KV`, `MCP_OBJECT`, `ASSETS`) must exist at deploy time.
