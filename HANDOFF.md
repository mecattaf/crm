# HANDOFF — 2026-06-12 session (Claude Fable 5, cc2)

## What exists now

**github.com/mecattaf/crm** — a custom, MCP-native CRM for Rani's team on pure Cloudflare
(one Worker + D1). **Backend is complete: 175/175 tests green on main.** No deploy happened
(by instruction); everything was validated locally in the `sodimo-etl-dev` distrobox via
vitest-pool-workers (real workerd + migrated D1).

| Merged PR | Issue(s) | Content |
|---|---|---|
| #10 | #1 #2 #3 | Scaffold (wrangler/Vite/vitest), full D1 schema + seeded pipelines/fx/admin, core services: CRUD, accent-insensitive search + filter grammar, name-or-id resolution, events on every mutation |
| #12 | #4 | `forecast` (Rani's pipedrive_pull.py semantics: stage weights, EUR fx, month buckets, unscheduled), `aggregate`, six named views (pipeline_board w/ rotting red/amber, overdue_activities, no_next_activity, stale_deals, recent_activity, my_day) |
| #11 | #6 | PBKDF2 + D1 sessions, login/consent pages, `workers-oauth-provider` composition; full DCR+PKCE flow tested end-to-end into authenticated `/mcp` |
| #13 | #5 | **The product**: 13 MCP tools over the services, tool descriptions as prompt-engineering (operand tables, field references, name-not-id rule), tested over real Streamable HTTP transport |
| #14 | #7 | REST API mirroring services 1:1 for the future SPA (session-cookie auth) |

Open: **#8 frontend wireframe** (not started — session budget hit STOP at 98% right after the
backend merged), **#9 deploy** (workflow committed, gated on `vars.DEPLOY_ENABLED` + secrets).

## How a client connects (once deployed)

`claude mcp add --transport http sodimo-crm https://<host>/mcp` — OAuth discovery, dynamic
registration, browser login (seeded dev admin: admin@sodimo.eu / changeme-sodimo — CHANGE IT),
consent, done. Every mutation is attributed to the granted user in the events timeline.

## What Tom must do to deploy (in order)

1. TASK-149: mint `sodimo-pilot-all` CF token (browser, Chrome Profile 1) → journal MD.
2. `wrangler kv namespace create OAUTH_KV` and `wrangler d1 create crm` (from sodimo@sodimo);
   put both ids in `wrangler.jsonc`.
3. `gh secret set CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`; set repo variable
   `DEPLOY_ENABLED=true`; run the deploy workflow.
4. Real users + password change; later: `crm.sodimonet.fr` route (do NOT put CF Access in
   front of `/mcp` — claude.ai OAuth breaks behind Access).

## Key design decisions (full detail in SPEC.md — read it first)

- 13 consolidated tools, not per-entity CRUD (Twenty's 286-tool catalog distilled: ~79% of it
  is platform machinery a 5-person team must not rebuild — no email/calendar mirrors, no
  runtime metadata, no view engine, no workflow builder).
- Rani's real needs drove the model: unlimited pipelines, exact Export Clients / New Leads -
  Wine stages with rot_days, stage-level forecast weights (100/50), org fields incl.
  Client Code (Sodiwin join key) + Accise 1/2, next-activity discipline (`no_next_activity`
  view), EUR/CHF/GBP/USD.
- The CRM never sends email (d-151/d-155 boundary). Repo on personal GitHub per explicit
  instruction (conscious exception to sodimo-* naming).
- services layer = single source of truth; MCP and REST are thin adapters over identical
  functions. ERP-dedup forecast hook + Pipedrive open-deal import are post-MVP.

## Session review

Orchestration: 4 parallel research agents (Cloudflare stack, Rani requirements from
may-crm + screenshots, Twenty teardown, backlog constraints) → SPEC.md synthesis → 9 issues →
3 implementation waves (1 foundation agent, then 2×2 parallel worktree agents), each PR
test-verified by the orchestrator before squash-merge. One real merge conflict (both Wave C
agents independently invented a `getWorkspace` service — near-identical; kept the MCP one,
enriched the REST route with the same field reference, rebased, 175 green). One real bug was
caught by transport-level tests (zod keeps explicitly-undefined keys; services distinguish
absent-vs-null). Budget: started 0% session / 57% weekly, ended 98% / ~67% — the five
implementation agents averaged ~140k tokens each; the backend fit in one session as planned,
the frontend didn't. Research-before-spec was the right call: the stack research (vitest 4.1
config API change, `agents` pinning, no-Access-in-front-of-MCP) and the "may-crm is vendored
upstream code, not Rani's curation" finding each prevented a wrong build.

Next session: frontend wireframe (#8) per SPEC.md GUI section — REST API and `npm run dev`
are ready for it; then deploy + seed-real-users + Pipedrive CSV import script.
