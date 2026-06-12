import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineBoardResult } from "../src/server/services/views";
import type { ForecastResult } from "../src/server/services/forecast";
import type { AggregateResult } from "../src/server/services/aggregate";
import type { WorkspaceResult } from "../src/server/services/workspace";
import type { ServiceRecord } from "../src/server/services/types";
import { seedDealFixture } from "./fixtures";
import { testDb } from "./helpers";
import { apiFetch, apiJson, loginCookie } from "./helpers/session";

/** Read-model endpoints: views, forecast, aggregate, workspace, events (issue #7). */

let cookie: string;
beforeEach(async () => {
  cookie = await loginCookie();
});

const get = <T>(path: string, status = 200) => apiJson<T>(cookie, "GET", path, undefined, status);

describe("GET /api/views/:name", () => {
  it("pipeline_board groups open deals by stage", async () => {
    await seedDealFixture(testDb());
    const board = await get<PipelineBoardResult>("/views/pipeline_board?pipeline=Export%20Clients");
    expect(board.pipeline.name).toBe("Export Clients");
    const counts = Object.fromEntries(board.stages.map((s) => [s.name, s.count]));
    expect(counts).toEqual({
      "Order received": 2, // archived + won excluded
      "Proforma Sent": 1,
      "Proforma confirmed": 1,
      Payment: 2,
      "Waiting for delivery": 0,
    });
  });

  it("pipeline_board without ?pipeline → 400", async () => {
    const res = await apiFetch(cookie, "GET", "/views/pipeline_board");
    expect(res.status).toBe(400);
  });

  it("overdue_activities lists past-due pending work", async () => {
    await apiJson(
      cookie,
      "POST",
      "/activities",
      { subject: "Ancient follow-up", activity_type: "task", due_date: "2020-01-01" },
      201,
    );
    const { data } = await get<{ data: { subject: string }[] }>("/views/overdue_activities");
    expect(data.map((a) => a.subject)).toContain("Ancient follow-up");
  });

  it("no_next_activity lists open deals without pending activities", async () => {
    await seedDealFixture(testDb());
    const { data } = await get<{ data: { title: string }[] }>("/views/no_next_activity");
    const titles = data.map((d) => d.title);
    expect(titles).toContain("Margaux June order");
    expect(titles).not.toContain("Won June deal");
    expect(titles).not.toContain("Archived deal");
  });

  it("stale_deals responds with the rotting list", async () => {
    await seedDealFixture(testDb());
    const { data } = await get<{ data: unknown[] }>("/views/stale_deals");
    expect(Array.isArray(data)).toBe(true);
  });

  it("recent_activity surfaces fresh events; non-numeric days → 400", async () => {
    await apiJson(cookie, "POST", "/organizations", { name: "Fresh Org" }, 201);
    const { data } = await get<{ data: { entity: string; kind: string }[] }>(
      "/views/recent_activity",
    );
    expect(data.some((e) => e.entity === "organization" && e.kind === "created")).toBe(true);

    const bad = await apiFetch(cookie, "GET", "/views/recent_activity?days=abc");
    expect(bad.status).toBe(400);
  });

  it("my_day builds the agenda; missing user → 400", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await apiJson(
      cookie,
      "POST",
      "/activities",
      { subject: "Taste with Rani", activity_type: "meeting", due_date: today, due_time: "10:30" },
      201,
    );
    const day = await get<{ user: { id: number }; items: { subject: string }[] }>(
      "/views/my_day?user=admin@sodimo.eu",
    );
    expect(day.user.id).toBe(1);
    expect(day.items.map((i) => i.subject)).toContain("Taste with Rani");

    const bad = await apiFetch(cookie, "GET", "/views/my_day");
    expect(bad.status).toBe(400);
  });

  it("unknown view name → 400 listing the allowed views", async () => {
    const res = await apiFetch(cookie, "GET", "/views/everything");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("pipeline_board");
  });
});

describe("GET /api/forecast", () => {
  it("buckets open deals by expected-close month in EUR", async () => {
    await seedDealFixture(testDb());
    const fc = await get<ForecastResult>("/forecast?pipeline=Export%20Clients");
    expect(fc.pipeline?.name).toBe("Export Clients");
    expect(fc.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    const june = fc.months.find((m) => m.month === "2026-06")!;
    expect(june.gross_eur).toBe(12120); // 10000 EUR + 2000 CHF @1.06
    expect(june.weighted_eur).toBe(11060);
    expect(fc.unscheduled.map((d) => d.title)).toEqual(["Unscheduled payment"]);
  });

  it("invalid months → 400", async () => {
    const zero = await apiFetch(cookie, "GET", "/forecast?months=0");
    expect(zero.status).toBe(400);
    const nan = await apiFetch(cookie, "GET", "/forecast?months=soon");
    expect(nan.status).toBe(400);
  });
});

describe("GET /api/aggregate", () => {
  it("counts and groups with the shared filter grammar", async () => {
    await seedDealFixture(testDb());

    const count = await get<AggregateResult>("/aggregate?entity=deal&metric=count&filter=status:eq:open");
    expect(count.value).toBe(7); // 9 seeded - won - archived

    const byCurrency = await get<AggregateResult>(
      "/aggregate?entity=deal&metric=sum:value&group_by=currency&filter=status:eq:open",
    );
    const sums = Object.fromEntries(byCurrency.groups!.map((g) => [g.key, g.value]));
    expect(sums).toEqual({ EUR: 18000, CHF: 2000, GBP: 1000, USD: 5000 });

    const byPipeline = await get<AggregateResult>(
      "/aggregate?entity=deal&metric=count&group_by=pipeline_id",
    );
    expect(byPipeline.groups!.map((g) => g.label)).toEqual(["Export Clients", "New Leads - Wine"]);
  });

  it("bad entity or metric → 400", async () => {
    const entity = await apiFetch(cookie, "GET", "/aggregate?entity=invoice&metric=count");
    expect(entity.status).toBe(400);
    const metric = await apiFetch(cookie, "GET", "/aggregate?entity=deal&metric=median:value");
    expect(metric.status).toBe(400);
  });
});

describe("GET /api/workspace", () => {
  it("returns pipelines+stages, users, currencies and the entity field reference", async () => {
    const ws = await get<WorkspaceResult & { fields: Record<string, { writable: { name: string; type: string }[] }> }>(
      "/workspace",
    );

    expect(ws.pipelines.map((p) => p.name)).toEqual(["Export Clients", "New Leads - Wine"]);
    const expCl = ws.pipelines[0]!;
    expect(expCl.stages).toHaveLength(5);
    expect(expCl.stages[0]).toMatchObject({ name: "Order received", rot_days: 1, forecast_weight: 50 });

    expect(ws.users.map((u) => u.email)).toContain("admin@sodimo.eu");
    expect(ws.users.every((u) => !("password_hash" in u))).toBe(true);

    const eur = ws.currencies.find((c) => c.currency === "EUR");
    expect(eur?.rate_to_eur).toBe(1);
    expect(ws.currencies).toHaveLength(4);

    expect(ws.fields.deal!.writable.find((f) => f.name === "value")?.type).toBe("money");
    expect(ws.fields.note!.writable.some((f) => f.name === "body")).toBe(true);
  });
});

describe("GET /api/events (record timeline)", () => {
  it("merges events, notes and activities for one record", async () => {
    const org = await apiJson<ServiceRecord>(cookie, "POST", "/organizations", { name: "Timeline Org" }, 201);
    await apiJson(cookie, "PATCH", `/organizations/${org.id}`, { category: "Wine" }, 200);
    await apiJson(cookie, "POST", "/notes", { body: "first touch", organization: org.id }, 201);

    const { data } = await get<{ data: { type: string; data: { kind?: string } }[] }>(
      `/events?entity=organization&id=${org.id}`,
    );
    const kinds = data.filter((i) => i.type === "event").map((i) => i.data.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("updated");
    expect(data.some((i) => i.type === "note")).toBe(true);
  });

  it("validates params: bad entity → 400, missing id → 400, unknown record → 404", async () => {
    expect((await apiFetch(cookie, "GET", "/events?entity=invoice&id=1")).status).toBe(400);
    expect((await apiFetch(cookie, "GET", "/events?entity=deal")).status).toBe(400);
    expect((await apiFetch(cookie, "GET", "/events?entity=deal&id=4242")).status).toBe(404);
  });
});
