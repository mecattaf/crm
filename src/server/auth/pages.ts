/**
 * Server-rendered auth pages (hono/html — interpolations are auto-escaped).
 * Minimal clean HTML, no client JS.
 */
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — Sodimo CRM</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917;
             display: flex; justify-content: center; padding-top: 10vh; margin: 0; }
      main { background: #fff; border: 1px solid #e7e5e4; border-radius: 8px;
             padding: 2rem; width: 100%; max-width: 22rem; }
      h1 { font-size: 1.1rem; margin: 0 0 1rem; }
      label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
      input[type="email"], input[type="password"] { width: 100%; box-sizing: border-box;
             padding: 0.5rem; border: 1px solid #d6d3d1; border-radius: 4px; }
      button { margin-top: 1.25rem; padding: 0.5rem 1rem; border-radius: 4px;
               border: 1px solid transparent; cursor: pointer; font-size: 0.9rem; }
      button.primary { background: #1c1917; color: #fff; width: 100%; }
      button.secondary { background: #fff; color: #1c1917; border-color: #d6d3d1; }
      .error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;
               padding: 0.5rem 0.75rem; border-radius: 4px; font-size: 0.85rem; }
      .muted { color: #78716c; font-size: 0.85rem; }
      ul { padding-left: 1.25rem; }
      .actions { display: flex; gap: 0.5rem; }
      .actions form { flex: 1; }
      .actions button { width: 100%; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
}

export function loginPage(opts: { error?: string; next?: string; email?: string }) {
  return layout(
    "Sign in",
    html`<h1>Sign in to Sodimo CRM</h1>
      ${opts.error ? html`<p class="error">${opts.error}</p>` : ""}
      <form method="post" action="/login">
        ${opts.next ? html`<input type="hidden" name="next" value="${opts.next}" />` : ""}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autofocus value="${opts.email ?? ""}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required />
        <button class="primary" type="submit">Sign in</button>
      </form>`,
  );
}

export function consentPage(opts: {
  clientName: string;
  scopes: string[];
  oauthReq: string; // base64url-encoded AuthRequest, round-tripped via hidden field
  userEmail: string;
}) {
  return layout(
    "Authorize",
    html`<h1>Authorize ${opts.clientName}</h1>
      <p class="muted">
        <strong>${opts.clientName}</strong> wants to access the Sodimo CRM as
        <strong>${opts.userEmail}</strong>.
      </p>
      ${opts.scopes.length > 0
        ? html`<p class="muted">Requested scopes:</p>
            <ul class="muted">
              ${opts.scopes.map((s) => html`<li>${s}</li>`)}
            </ul>`
        : html`<p class="muted">No specific scopes requested (full access).</p>`}
      <div class="actions">
        <form method="post" action="/authorize">
          <input type="hidden" name="oauth_req" value="${opts.oauthReq}" />
          <input type="hidden" name="decision" value="deny" />
          <button class="secondary" type="submit">Deny</button>
        </form>
        <form method="post" action="/authorize">
          <input type="hidden" name="oauth_req" value="${opts.oauthReq}" />
          <input type="hidden" name="decision" value="approve" />
          <button class="primary" type="submit">Approve</button>
        </form>
      </div>`,
  );
}

export function errorPage(message: string) {
  return layout("Error", html`<h1>Something went wrong</h1><p class="error">${message}</p>`);
}
