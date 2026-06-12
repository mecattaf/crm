import { beforeAll, describe, expect, it } from "vitest";
import { seedDealFixture } from "./fixtures";
import { createMcpClient, type McpClient } from "./helpers/mcp-client";
import { testDb } from "./helpers";

/**
 * forecast / aggregate / get_workspace through the real MCP transport,
 * against the deterministic deal fixture (see tests/fixtures.ts for the
 * expected EUR conversions and weights).
 */

let mcp: McpClient;

beforeAll(async () => {
  mcp = await createMcpClient();
});

interface ForecastShape {
  pipeline: { id: number; name: string } | null;
  months: { month: string; gross_eur: number; weighted_eur: number; deals: unknown[] }[];
  unscheduled: { title: string }[];
  total_gross_eur: number;
  total_weighted_eur: number;
}

describe("forecast", () => {
  it("buckets open deals by close month with EUR conversion and stage weights", async () => {
    await seedDealFixture(testDb());
    const res = await mcp.callToolJson<ForecastShape>("forecast", {});
    expect(res.pipeline).toBeNull();
    expect(res.months.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08"]);
    const june = res.months.find((m) => m.month === "2026-06");
    expect(june?.gross_eur).toBe(12120); // 10000 EUR + 2000 CHF @1.06
    expect(june?.weighted_eur).toBe(11060); // w100 + w50
    expect(res.unscheduled.map((d) => d.title)).toEqual(["Unscheduled payment"]);
    expect(res.total_gross_eur).toBe(22890);
    expect(res.total_weighted_eur).toBe(16445);
  });

  it("narrows to a pipeline by NAME and sets structuredContent", async () => {
    await seedDealFixture(testDb());
    const raw = await mcp.callTool("forecast", { pipeline: "new leads" });
    expect(raw.isError).toBeFalsy();
    const structured = raw.structuredContent as unknown as ForecastShape;
    expect(structured.pipeline?.name).toBe("New Leads - Wine");
    expect(structured.months.map((m) => m.month)).toEqual(["2026-07"]);
    expect(structured.months[0]?.gross_eur).toBe(4600); // 5000 USD @0.92
    // text content carries the same compact JSON
    expect(JSON.parse(raw.content[0]?.text ?? "")).toEqual(structured);
  });
});

describe("aggregate", () => {
  it("counts with filters and labels FK group keys", async () => {
    await seedDealFixture(testDb());
    const open = await mcp.callToolJson<{ value: number }>("aggregate", {
      entity: "deal",
      metric: "count",
      filters: [{ field: "status", op: "eq", value: "open" }],
    });
    expect(open.value).toBe(7); // 9 created - 1 won - 1 archived

    const byPipeline = await mcp.callToolJson<{
      groups: { key: number; label: string | null; value: number }[];
    }>("aggregate", {
      entity: "deal",
      metric: "sum:value",
      group_by: "pipeline_id",
      filters: [{ field: "status", op: "eq", value: "open" }],
    });
    const labels = byPipeline.groups.map((g) => g.label);
    expect(labels).toContain("Export Clients");
    expect(labels).toContain("New Leads - Wine");
    const leads = byPipeline.groups.find((g) => g.label === "New Leads - Wine");
    expect(leads?.value).toBe(5000); // decimal, raw currency (USD), no FX
  });
});

describe("get_workspace (no view): orientation", () => {
  it("returns pipelines+stages, users, currencies and the field reference", async () => {
    const ws = await mcp.callToolJson<{
      pipelines: {
        name: string;
        stages: { name: string; rot_days: number | null; forecast_weight: number }[];
      }[];
      users: { id: number; email: string; role: string }[];
      currencies: { currency: string; rate_to_eur: number }[];
      fields: Record<string, { writable: unknown[]; read_only: unknown[]; filterable: unknown[] }>;
    }>("get_workspace", {});

    expect(ws.pipelines.map((p) => p.name)).toEqual(["Export Clients", "New Leads - Wine"]);
    const exportStages = ws.pipelines[0]?.stages ?? [];
    expect(exportStages.map((s) => s.name)).toEqual([
      "Order received",
      "Proforma Sent",
      "Proforma confirmed",
      "Payment",
      "Waiting for delivery",
    ]);
    expect(exportStages.find((s) => s.name === "Payment")?.forecast_weight).toBe(100);
    expect(exportStages.find((s) => s.name === "Payment")?.rot_days).toBe(3);
    expect(ws.pipelines[1]?.stages).toHaveLength(8);

    expect(ws.users.some((u) => u.id === 1 && u.role === "admin")).toBe(true);
    expect(ws.currencies.find((c) => c.currency === "EUR")?.rate_to_eur).toBe(1);
    expect(ws.currencies.map((c) => c.currency).sort()).toEqual(["CHF", "EUR", "GBP", "USD"]);

    // field reference generated from the same constants as the descriptions
    for (const entity of ["organization", "contact", "deal", "activity", "note"]) {
      expect(ws.fields[entity]?.writable.length).toBeGreaterThan(0);
      expect(ws.fields[entity]?.filterable.length).toBeGreaterThan(0);
    }
    const dealWritable = ws.fields["deal"]?.writable as { name: string; type: string }[];
    expect(dealWritable.find((f) => f.name === "value")?.type).toBe("money");
  });
});

describe("get_workspace (views)", () => {
  it("pipeline_board returns deals by stage with rotting flags and totals", async () => {
    await seedDealFixture(testDb());
    const board = await mcp.callToolJson<{
      pipeline: { name: string };
      stages: {
        name: string;
        count: number;
        gross_eur: number;
        deals: { title: string; value: number; rotting: string; next_activity: unknown }[];
      }[];
    }>("get_workspace", { view: "pipeline_board", pipeline: "Export Clients" });

    expect(board.pipeline.name).toBe("Export Clients");
    expect(board.stages.map((s) => s.name)).toEqual([
      "Order received",
      "Proforma Sent",
      "Proforma confirmed",
      "Payment",
      "Waiting for delivery",
    ]);
    const payment = board.stages.find((s) => s.name === "Payment");
    expect(payment?.count).toBe(2); // Margaux June order + Unscheduled payment (won/archived excluded)
    expect(payment?.gross_eur).toBe(13000);
    for (const stage of board.stages) {
      for (const deal of stage.deals) {
        expect(["red", "amber", "none"]).toContain(deal.rotting);
        expect(deal.next_activity).toBeNull(); // fixture schedules no activities
      }
    }
  });

  it("pipeline_board without a pipeline fails with an instructive error", async () => {
    const res = await mcp.callTool("get_workspace", { view: "pipeline_board" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("needs a pipeline");
  });

  it("no_next_activity lists open deals with no pending activity", async () => {
    await seedDealFixture(testDb());
    const deals = await mcp.callToolJson<{ title: string; status?: string }[]>("get_workspace", {
      view: "no_next_activity",
      pipeline: "Export Clients",
    });
    expect(deals).toHaveLength(6); // 6 open Export deals, none with activities
    expect(deals.map((d) => d.title)).not.toContain("Won June deal");
    expect(deals.map((d) => d.title)).not.toContain("Archived deal");
  });

  it("my_day defaults to the OAuth user", async () => {
    await mcp.callToolJson("schedule_activity", {
      subject: "Préparer les proformas",
      type: "task",
      due_date: new Date().toISOString().slice(0, 10),
    });
    const day = await mcp.callToolJson<{
      user: { id: number };
      items: { subject: string }[];
    }>("get_workspace", { view: "my_day" });
    expect(day.user.id).toBe(1);
    expect(day.items.map((i) => i.subject)).toContain("Préparer les proformas");
  });
});
