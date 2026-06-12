import { beforeAll, describe, expect, it } from "vitest";
import { createMcpClient, type McpClient } from "./helpers/mcp-client";

/**
 * The MCP tool surface over the REAL stack: OAuth (DCR + PKCE) once per file,
 * then JSON-RPC tools/* over Streamable HTTP at POST /mcp. The grant belongs
 * to the seeded admin (user id 1) — event attribution asserts on that.
 */

let mcp: McpClient;

beforeAll(async () => {
  mcp = await createMcpClient();
});

const TOOL_NAMES = [
  "search_records",
  "get_record",
  "create_record",
  "update_record",
  "archive_record",
  "delete_record",
  "move_deal",
  "log_note",
  "schedule_activity",
  "complete_activity",
  "aggregate",
  "forecast",
  "get_workspace",
];

interface Rec {
  id: number;
  [key: string]: unknown;
}

describe("tools/list", () => {
  it("returns the 13-tool surface, each with a description and schema", async () => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.inputSchema?.type, `${t.name} schema`).toBe("object");
      expect(Object.keys(t.inputSchema?.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("embeds the reference tables in the descriptions (prompt engineering)", async () => {
    const tools = await mcp.listTools();
    const desc = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
    // operand table + per-entity filter fields live in search_records
    expect(desc("search_records")).toContain("in_next_days");
    expect(desc("search_records")).toContain("is_overdue");
    expect(desc("search_records")).toContain("expected_close_date:date");
    // entity field lists (incl. Rani's custom columns) live in create_record
    expect(desc("create_record")).toContain("accise_1");
    expect(desc("create_record")).toContain("EUR");
    expect(desc("create_record")).toContain("move_deal");
    // names-not-ids rule is taught where it matters
    expect(desc("update_record")).toContain("id OR a human-readable name");
    expect(desc("move_deal")).toContain("ONLY way");
  });
});

describe("search_records", () => {
  it("finds records by fuzzy accent-insensitive query", async () => {
    await mcp.callToolJson("create_record", {
      entity: "organization",
      data: [{ name: "Château Margaux Négoce" }, { name: "London Cellars" }],
    });
    const res = await mcp.callToolJson<{ items: Rec[]; next_cursor: string | null }>(
      "search_records",
      { entity: "organization", query: "chateau margaux" },
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.["name"]).toBe("Château Margaux Négoce");
    expect(res.next_cursor).toBeNull();
  });
});

describe("create / update / get round-trip", () => {
  it("returns full records and attributes events to the OAuth user", async () => {
    const org = await mcp.callToolJson<Rec>("create_record", {
      entity: "organization",
      data: { name: "Vinexport SARL", category: "négociant" },
    });
    expect(org.id).toBeTypeOf("number");
    expect(org["name"]).toBe("Vinexport SARL");
    expect(org).not.toHaveProperty("name_norm"); // *_norm never leaks

    // update by NAME, not id
    const updated = await mcp.callToolJson<Rec>("update_record", {
      entity: "organization",
      id: "Vinexport",
      patch: { client_code: "VX-042" },
    });
    expect(updated.id).toBe(org.id);
    expect(updated["client_code"]).toBe("VX-042");
    expect(updated["name"]).toBe("Vinexport SARL"); // full record, not a patch echo

    const full = await mcp.callToolJson<Rec & { timeline: { type: string; data: Rec }[] }>(
      "get_record",
      { entity: "organization", id: org.id, include: ["timeline"] },
    );
    const events = full.timeline.filter((t) => t.type === "event");
    expect(events.map((e) => e.data["kind"])).toEqual(["created", "updated"]);
    for (const e of events) expect(e.data["actor_user_id"]).toBe(1); // the OAuth admin
  });
});

describe("move_deal", () => {
  it("moves by stage NAME, wins, and attributes the events", async () => {
    const deal = await mcp.callToolJson<Rec>("create_record", {
      entity: "deal",
      data: {
        title: "Bordeaux pallet order",
        pipeline: "Export Clients",
        value: 1500.5,
        currency: "EUR",
      },
    });
    expect(deal["value"]).toBe(1500.5); // decimal at the surface

    const moved = await mcp.callToolJson<Rec>("move_deal", {
      deal: "Bordeaux pallet",
      stage: "Proforma Sent",
    });
    expect(moved.id).toBe(deal.id);
    expect(moved["stage_id"]).not.toBe(deal["stage_id"]);
    expect(moved["stage_changed_at"]).not.toBe(deal["stage_changed_at"]);

    const won = await mcp.callToolJson<Rec>("move_deal", { deal: deal.id, status: "won" });
    expect(won["status"]).toBe("won");
    expect(won["won_at"]).toBeTruthy();

    const full = await mcp.callToolJson<Rec & { timeline: { type: string; data: Rec }[] }>(
      "get_record",
      { entity: "deal", id: deal.id, include: ["timeline"] },
    );
    const events = full.timeline.filter((t) => t.type === "event");
    expect(events.map((e) => e.data["kind"])).toEqual(["created", "stage_changed", "won"]);
    const stageEvt = events[1]?.data["payload"] as Record<string, unknown>;
    expect(stageEvt["to_stage"]).toBe("Proforma Sent");
    for (const e of events) expect(e.data["actor_user_id"]).toBe(1);
  });

  it("rejects stage/status patches through update_record with a pointer to move_deal", async () => {
    const deal = await mcp.callToolJson<Rec>("create_record", {
      entity: "deal",
      data: { title: "Patch guard deal" },
    });
    const res = await mcp.callTool("update_record", {
      entity: "deal",
      id: deal.id,
      patch: { status: "won" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("move_deal");
  });
});

describe("delete_record friction", () => {
  it("fails without confirm with an instructive error, succeeds with it", async () => {
    const org = await mcp.callToolJson<Rec>("create_record", {
      entity: "organization",
      data: { name: "Éphémère SAS" },
    });

    const refused = await mcp.callTool("delete_record", { entity: "organization", id: org.id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("confirm: true");
    expect(refused.content[0]?.text).toContain("archive_record");

    const deleted = await mcp.callToolJson<{ deleted: boolean; record: Rec }>("delete_record", {
      entity: "organization",
      id: org.id,
      confirm: true,
    });
    expect(deleted.deleted).toBe(true);
    expect(deleted.record.id).toBe(org.id);

    const gone = await mcp.callTool("get_record", { entity: "organization", id: org.id });
    expect(gone.isError).toBe(true);
  });
});

describe("ambiguity self-correction", () => {
  it("surfaces the candidate list when a name matches several records", async () => {
    await mcp.callToolJson("create_record", {
      entity: "organization",
      data: [{ name: "Maison Dupont" }, { name: "Dupont Frères" }],
    });
    const res = await mcp.callTool("get_record", { entity: "organization", id: "dupont" });
    expect(res.isError).toBe(true);
    const text = res.content[0]?.text ?? "";
    expect(text).toContain("Candidates");
    expect(text).toContain("Maison Dupont");
    expect(text).toContain("Dupont Frères");
  });
});

describe("log_note / schedule_activity / complete_activity loop", () => {
  it("logs, schedules (assignee defaults to the OAuth user) and completes", async () => {
    const org = await mcp.callToolJson<Rec>("create_record", {
      entity: "organization",
      data: { name: "Cave Coopérative de Bandol" },
    });

    const note = await mcp.callToolJson<Rec>("log_note", {
      body: "Appel avec le gérant : intéressé par le millésime 2024.",
      organization: "Cave Coopérative",
    });
    expect(note["org_id"]).toBe(org.id);
    expect(note["author_id"]).toBe(1);

    const act = await mcp.callToolJson<Rec>("schedule_activity", {
      subject: "Rappeler le gérant",
      type: "call",
      due_date: "2026-06-20",
      organization: org.id,
    });
    expect(act["assignee_id"]).toBe(1); // defaults to the acting OAuth user
    expect(act["done"]).toBe(false);

    const done = await mcp.callToolJson<Rec>("complete_activity", {
      activity: "Rappeler le gérant", // by subject
      done_note: "Fait — relance par email.",
    });
    expect(done.id).toBe(act.id);
    expect(done["done"]).toBe(true);
    expect(done["note"]).toBe("Fait — relance par email.");

    const again = await mcp.callTool("complete_activity", { activity: act.id });
    expect(again.isError).toBe(true);
    expect(again.content[0]?.text).toContain("already done");

    const orphan = await mcp.callTool("log_note", { body: "Sans lien" });
    expect(orphan.isError).toBe(true);
    expect(orphan.content[0]?.text).toContain("at least one");
  });
});
