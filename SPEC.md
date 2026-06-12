# Sodimo CRM — Specification

A custom, MCP-native CRM for a ~5-person wine/spirits export trading team (Sodimo France SAS).
Replaces Pipedrive (and the abandoned self-hosted Twenty CRM). 100% Cloudflare: one Worker,
one D1 database. The **primary interface is a remote MCP server** consumed by Claude
(claude.ai connectors, Claude Code, Claude Desktop); the web GUI is a secondary surface.

## Hard constraints

- **Pure Cloudflare.** Workers + D1 + KV + Durable Objects only. No local servers. Free tier.
- **The CRM never sends email.** No SMTP, no mail API calls, no inbox sync. Stage-change
  automations may only write events/activities; outbound mail is a separate system's job (d-151).
- **MCP-first.** Every capability exists as a service function consumed by BOTH the MCP tools
  and the REST API. The GUI never gets a capability the MCP lacks.
- **Tiny scale, by design.** ~400 deals ever, low-hundreds of orgs/contacts, 5 users.
  No multi-tenancy, no runtime metadata engine, no workflow builder, no view engine.

## Stack (decided 2026-06-12, do not relitigate)

| Layer | Choice |
|---|---|
| MCP server | `agents` SDK `McpAgent`, Streamable HTTP at `/mcp` (no SSE) |
| MCP/GUI auth | `@cloudflare/workers-oauth-provider` (OAuth 2.1 + PKCE + DCR for claude.ai); GUI = email+password against D1 `users` + HttpOnly signed session cookie; `/authorize` consent reuses the GUI session; user identity arrives in tools via `this.props` |
| Backend | Hono as OAuthProvider `defaultHandler`: login, `/api/*` REST, asset fallback |
| DB | D1 + Drizzle ORM. `drizzle-kit generate` → SQL in `drizzle/migrations/` → `wrangler d1 migrations apply`. No interactive transactions on D1: use `db.batch()` |
| Frontend | Vite 7 + `@cloudflare/vite-plugin`, React 19 SPA, React Router as library, Tailwind v4 + shadcn/ui (vanilla, unthemed — brand kit applied later) |
| Testing | `vitest@^4.1` + `@cloudflare/vitest-pool-workers`; real D1 via `applyD1Migrations` in setup; service-layer unit tests + `SELF.fetch` integration tests; MCP tested via JSON-RPC over `SELF.fetch("/mcp")` where stable, services directly otherwise |
| CI | GitHub Actions: typecheck + test + build on PR; deploy job (wrangler-action@v3, migrations as separate named step) exists but requires `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets — NOT run this session |
| Versions | `agents@^0.9` (MCP SDK pinned transitively — never install `@modelcontextprotocol/sdk` directly), `@cloudflare/workers-oauth-provider@^0.8`, `hono@^4.12`, `zod@^4.3`, `wrangler@^4.79`, `react@^19`, `vite@^7`, `tailwindcss@^4` |

Worker entry composition (`src/server/index.ts`):

```ts
export default new OAuthProvider({
  apiHandlers: { "/mcp": CrmMCP.serve("/mcp") },
  defaultHandler: app,            // Hono
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
})
```

`wrangler.jsonc`: assets binding with `not_found_handling: "single-page-application"` and
`run_worker_first: ["/mcp", "/api/*", "/authorize", "/token", "/register", "/.well-known/*", "/login", "/logout", "/oauth/*"]`;
SQLite-backed DO class `CrmMCP` (`new_sqlite_classes` — free-tier compatible); D1 binding `DB`
with `migrations_dir: "drizzle/migrations"`; KV binding `OAUTH_KV`.

**McpAgent state is per-session and disposable — D1 is the only source of truth.**

## Data model

All tables: integer autoincrement `id`, `created_at`/`updated_at` (ISO-8601 TEXT, UTC),
`archived_at` nullable TEXT for soft archive. Money stored as **integer cents** + currency code.
Dates DATE-only as `YYYY-MM-DD` TEXT. Free-text search must be accent-insensitive (normalize
on write into companion `*_norm` columns; LIKE against normalized input).

- **users** — email (unique), name, password_hash (PBKDF2-SHA256 via WebCrypto, ≥600k iters,
  per-user salt), role `admin|member`. Sessions: **sessions** table (id = random 256-bit token
  hash, user_id, expires_at) referenced by HttpOnly cookie.
- **pipelines** — name, position. Unlimited pipelines (explicit Rani requirement).
- **stages** — pipeline_id FK, name, position, `rot_days` INTEGER (staleness threshold,
  nullable = never rots), `forecast_weight` INTEGER 0–100 (stage-level weighting; deal-level
  probability deliberately does not exist).
- **organizations** — name (+name_norm), `client_code` (Sodiwin ERP join key), `category`,
  `org_type`, `delivery_address`, `accise_1`, `accise_2`, address, owner_id FK users.
  (Fixed columns — Rani's exact Pipedrive custom fields. No custom-field engine.)
- **contacts** — first_name, last_name (+norm), org_id FK nullable, email, phone, job_title,
  owner_id.
- **deals** — title (+norm), org_id, contact_id, pipeline_id, stage_id, `value_cents`,
  `currency` (EUR|CHF|GBP|USD), `expected_close_date` (nullable — excluded from forecast
  totals when null), status `open|won|lost`, `lost_reason`, label, owner_id,
  `stage_changed_at` (drives rotting), won_at/lost_at.
- **activities** — subject, `activity_type` (call|meeting|task|deadline|email|lunch),
  due_date, due_time nullable, duration_min nullable, priority (none|high), `done` flag +
  done_at, note, assignee_id FK users, nullable FKs deal_id/org_id/contact_id (direct links,
  Pipedrive-style — polymorphic junctions are overkill at this scale).
- **notes** — body, author_id, nullable FKs deal_id/org_id/contact_id (≥1 required, enforced
  in service layer).
- **events** — append-only system log: entity, entity_id, kind (created|updated|stage_changed|
  won|lost|archived|…), payload JSON (old/new values), actor_user_id, created_at. Feeds the
  per-record timeline (timeline = events ∪ notes ∪ activities, merged at read time).
- **fx_rates** — currency PK, `rate_to_eur_micros` INTEGER, as_of date. Seeded statically;
  admin-updatable. (No external FX API calls.)

Seed data (own migration or seed script): the two real pipelines —
**Export Clients**: Order received (rot 1) → Proforma Sent (rot 3) → Proforma confirmed (rot 1)
→ Payment (rot 3, weight 100) → Waiting for delivery (rot 5, weight 100); all other stages
weight 50.
**New Leads - Wine**: Lead Received → Qualification → Product & Price Presentation →
Follow-up / Feedback → Negotiation → Order Confirmation → Delivery & Onboarding →
Post-Sale Follow-Up (all weight 50, rot nullable).

## MCP tool surface (12 tools)

Consolidated verbs with `entity` parameters — NOT per-entity CRUD (Twenty's 286-tool mistake).
Entity ∈ `organization|contact|deal|activity|note`. Ergonomics rules, non-negotiable:
- Accept human-readable names everywhere (stage names, pipeline names, user names/emails,
  org names) and resolve server-side; IDs also accepted. Never force the model to look up IDs.
- Flat field names (`first_name`, `value` as decimal EUR-style float in/out — converted to/from
  cents internally), no dot-paths, no micros.
- Every mutation returns the full updated record. Compact JSON, no GraphQL edges.
- Filter operand tables and entity field lists live in the tool descriptions.
- Soft archive only; `delete_record` requires `confirm: true`, never batched.

1. `search_records(entity, query?, filters?, sort?, limit?, cursor?)` — `query` = fuzzy
   accent-insensitive cross-field match (the #1 LLM need: "who is X?"); `filters` =
   `[{field, op, value}]` with typed operands incl. relative dates (`is_today`, `is_overdue`,
   `in_past`, `in_next_days:N`, `in_last_days:N`); flat `and` semantics + optional `or` groups.
2. `get_record(entity, id_or_name, include?)` — include ∈ {timeline, activities, notes, deals,
   contacts}; assembles full context in ONE call.
3. `create_record(entity, data | data[])` — single or heterogeneous batch.
4. `update_record(entity, id, patch)` or `update_record(entity, items: [{id, patch}])` —
   heterogeneous bulk update (the gap Twenty never fixed).
5. `archive_record(entity, id)` / 6. `delete_record(entity, id, confirm)` — asymmetric
   destructive friction.
7. `move_deal(deal, stage?, status?, lost_reason?)` — stage transition and/or won/lost;
   writes `stage_changed_at` + event. Stage resolvable by name within the deal's pipeline.
8. `log_note(body, deal?, organization?, contact?)`.
9. `schedule_activity(subject, type, due_date, due_time?, assignee?, deal?, organization?,
   contact?, priority?, note?)` + `complete_activity(activity, done_note?)` — the
   next-activity discipline is the product's core loop; first-class verbs.
10. `aggregate(entity, group_by?, metric: count|sum:field|avg:field, filters?)` — replaces
    dashboards.
11. `forecast(pipeline?, months?)` — the CEO job: open deals grouped by expected-close month,
    weighted by stage `forecast_weight`, converted to EUR via fx_rates; returns per-month
    {gross, weighted, deals[]} + unscheduled bucket (deals lacking close dates, listed but
    not totalled). Must replicate `pipedrive_pull.py` semantics. (ERP invoice dedup = post-MVP
    hook, not in scope.)
12. `get_workspace(view?)` — no args: pipelines+stages (with weights/rot), users, currencies,
    entity field reference. With `view`: canned named queries —
    `pipeline_board(pipeline)` (deals by stage with rotting flags: red = days in stage >
    rot_days, amber = ≥80%), `overdue_activities`, `no_next_activity` (open deals with zero
    pending activities — Rani's explicit ask), `stale_deals`, `recent_activity(days=7)`,
    `my_day(user, date?)` (agenda).

## REST API (GUI surface, mirrors services 1:1)

`/api/auth/login|logout|me`; `/api/{organizations,contacts,deals,activities,notes}` CRUD with
same filter grammar (query params); `/api/deals/:id/move`; `/api/activities/:id/complete`;
`/api/views/:name`; `/api/forecast`; `/api/workspace`; `/api/events?entity=&id=` (timeline).
Session-cookie auth; 401 JSON for unauthenticated.

## GUI wireframe (phase 2, unthemed shadcn)

Kanban per pipeline (stage columns, count+sum headers, rotting color dots, next-activity
icon), deal detail drawer (fields, stage progress bar, timeline tab, activities tab, notes
tab, won/lost buttons), org/contact list+detail, forecast table (months × deals, gross +
weighted totals), "My day" agenda list, login page. Clickable wireframe quality; design pass
comes later with a brand kit.

## Non-goals (explicit)

Email send/sync/inbox (biggest deliberate gap — Gmail stays Gmail); calendar sync;
products/line-items; leads as separate entity (a pipeline does it); files/attachments (post-MVP;
R2 hook sketched in schema via events payload only); webhooks; runtime custom fields/objects;
workflow builder; dashboards beyond `aggregate`+`forecast`; multi-workspace; Pipedrive
historical migration (forward-looking; open-deal CSV import is a post-MVP script).

## Conventions

TypeScript strict everywhere. CalVer tags `YYYY-MM-DD-slug`. Conventional commits.
Issues → branches `feat/<n>-slug` → PRs → squash-merge. French-locale awareness in GUI
formatting only (server stores ISO/UTC/cents). Repo: github.com/mecattaf/crm (public —
no secrets, no real customer data ever committed; seed data is fictional).
