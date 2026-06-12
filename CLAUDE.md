# crm

MCP-native CRM on Cloudflare Workers + D1. **Read SPEC.md first** — it is the single source
of truth for stack, data model, tool surface, and non-goals. Do not relitigate decisions there.

## Commands

All node/npm commands on this machine MUST run inside the distrobox:

```sh
distrobox enter sodimo-etl-dev -- bash -lc 'cd /var/home/tom/leger/june/crm && <command>'
```

- `npm run check` — typecheck (tsc --noEmit)
- `npm test` — vitest (workers pool, real D1 with migrations applied)
- `npm run db:generate` — drizzle-kit generate (after editing src/server/db/schema.ts)
- `npm run dev` — vite dev server (Worker + SPA, local D1 state in .wrangler/state)
- `npm run build` — vite build (client + worker)

git/gh run on the host (NOT in the distrobox).

## Architecture invariants

- Single Worker: `OAuthProvider` wraps `McpAgent` (`/mcp`) + Hono default handler (`/api/*`,
  auth, SPA assets). See SPEC.md for entry composition.
- **services layer is the law**: `src/server/services/` exposes plain
  `(db, input, actor) => result` functions. MCP tools and REST routes are thin adapters over
  the SAME service functions. Never put logic in a tool handler or route.
- D1 has no interactive transactions — use `db.batch()` for multi-statement atomic writes.
- Money = integer cents + currency column; convert at the edge. Dates = ISO TEXT, UTC.
- Soft archive (`archived_at`); hard delete only via confirm-gated path; no bulk delete.
- Every mutation writes an `events` row (timeline) in the same batch.
- Never install `@modelcontextprotocol/sdk` directly — it comes transitively via `agents`.
- The CRM never sends email. Do not add mail capabilities of any kind.

## Workflow

Issues → branch `feat/<issue>-slug` → PR referencing the issue → squash-merge.
Tests must pass in the workers pool before any merge. Conventional commits.
