import { describe, expect, it } from "vitest";
import { completeActivity } from "../src/server/services/activities";
import { moveDeal } from "../src/server/services/deals";
import { ValidationError } from "../src/server/services/errors";
import { archiveRecord, createRecord, updateRecord } from "../src/server/services/records";
import type { ServiceRecord } from "../src/server/services/types";
import {
  myDay,
  noNextActivity,
  overdueActivities,
  pipelineBoard,
  recentActivity,
  staleDeals,
} from "../src/server/services/views";
import { createUser, daysAgo } from "./fixtures";
import { NOW, admin, testDb } from "./helpers";

// NOW = 2026-06-12T10:00:00Z. Export Clients stage rot_days:
// Order received 1, Proforma Sent 3, Proforma confirmed 1, Payment 3,
// Waiting for delivery 5. New Leads - Wine: all NULL (never rots).

type Db = ReturnType<typeof testDb>;

async function deal(db: Db, data: Record<string, unknown>, now: string = NOW) {
  return (await createRecord(db, { entity: "deal", data, now }, admin)) as ServiceRecord;
}

/**
 * Rotting board fixture (Export Clients). days_in_stage derives from the
 * creation `now`:
 *   A  Order received        0d -> none   (0 < 0.8*1)
 *   B  Order received        1d -> amber  (exactly rot_days: NOT red, >= 0.8)
 *   C  Order received        2d -> red    (> rot_days)
 *   D  Waiting for delivery  4d -> amber  (exactly 0.8 * 5)
 *   E  Waiting for delivery  3d -> none   (< 0.8 * 5)
 *   F  Waiting for delivery  6d -> red
 *   L  Lead Received (P2)  100d -> none   (rot_days NULL never rots)
 * G (won) and H (archived) must appear nowhere.
 */
async function seedBoard(db: Db) {
  const org = (await createRecord(
    db,
    { entity: "organization", data: { name: "Berlin Wein Kontor" }, now: NOW },
    admin,
  )) as ServiceRecord;
  const contact = (await createRecord(
    db,
    {
      entity: "contact",
      data: { first_name: "Hans", last_name: "Keller", organization: org["id"] as number },
      now: NOW,
    },
    admin,
  )) as ServiceRecord;

  const base = { pipeline: "Export Clients", organization: org["id"] as number };
  const A = await deal(db, {
    ...base,
    title: "A fresh",
    stage: "Order received",
    value: 1000,
    currency: "EUR",
    contact: contact["id"] as number,
    owner: "Sodimo Admin",
  });
  const B = await deal(
    db,
    { ...base, title: "B at boundary", stage: "Order received", value: 2000, currency: "CHF" },
    daysAgo(1),
  );
  const C = await deal(
    db,
    { ...base, title: "C rotten", stage: "Order received", value: 500, currency: "EUR" },
    daysAgo(2),
  );
  const D = await deal(
    db,
    { ...base, title: "D amber boundary", stage: "Waiting for delivery", value: 100 },
    daysAgo(4),
  );
  const E = await deal(
    db,
    { ...base, title: "E fine", stage: "Waiting for delivery", value: 100 },
    daysAgo(3),
  );
  const F = await deal(
    db,
    { ...base, title: "F very rotten", stage: "Waiting for delivery", value: 100 },
    daysAgo(6),
  );
  const G = await deal(db, { ...base, title: "G won", stage: "Order received", value: 700 });
  await moveDeal(db, { deal: G["id"] as number, status: "won", now: NOW }, admin);
  const H = await deal(db, { ...base, title: "H archived", stage: "Order received", value: 800 });
  await archiveRecord(db, { entity: "deal", id: H["id"] as number, now: NOW }, admin);
  const L = await deal(
    db,
    { title: "L old lead", pipeline: "New Leads - Wine", stage: "Lead Received", value: 100 },
    daysAgo(100),
  );

  // next-activity material for A: pending 06-13 (no time) beats pending 06-14 09:00;
  // the done one (06-01) must never surface.
  const acts = (await createRecord(
    db,
    {
      entity: "activity",
      data: [
        { subject: "later call", activity_type: "call", due_date: "2026-06-14", due_time: "09:00", deal: A["id"] as number },
        { subject: "next follow-up", activity_type: "task", due_date: "2026-06-13", deal: A["id"] as number },
        { subject: "already done", activity_type: "email", due_date: "2026-06-01", deal: A["id"] as number },
      ],
      now: NOW,
    },
    admin,
  )) as ServiceRecord[];
  await completeActivity(db, { activity: acts[2]!["id"] as number, now: NOW }, admin);

  return { org, contact, A, B, C, D, E, F, G, H, L };
}

describe("pipeline_board", () => {
  it("lists stages in position order with count + gross EUR headers", async () => {
    const db = testDb();
    await seedBoard(db);
    const board = await pipelineBoard(db, { pipeline: "Export Clients", now: NOW });

    expect(board.pipeline).toEqual({ id: 1, name: "Export Clients" });
    expect(board.stages.map((s) => s.name)).toEqual([
      "Order received",
      "Proforma Sent",
      "Proforma confirmed",
      "Payment",
      "Waiting for delivery",
    ]);

    const received = board.stages[0]!;
    expect(received.count).toBe(3); // A, B, C — G (won) + H (archived) excluded
    expect(received.gross_eur).toBe(3620); // 1000 + 2000 CHF * 1.06 + 500
    expect(received.deals.map((d) => d.title)).toEqual(["A fresh", "B at boundary", "C rotten"]);

    const empty = board.stages[1]!;
    expect(empty.count).toBe(0);
    expect(empty.gross_eur).toBe(0);
    expect(empty.deals).toEqual([]);
  });

  it("flags rotting at the exact boundaries (red > rot_days, amber >= 0.8x)", async () => {
    const db = testDb();
    await seedBoard(db);
    const board = await pipelineBoard(db, { pipeline: "Export Clients", now: NOW });
    const flags = new Map(
      board.stages.flatMap((s) => s.deals.map((d) => [d.title, d.rotting] as const)),
    );
    expect(flags.get("A fresh")).toBe("none");
    expect(flags.get("B at boundary")).toBe("amber"); // exactly rot_days = 1
    expect(flags.get("C rotten")).toBe("red");
    expect(flags.get("D amber boundary")).toBe("amber"); // exactly 0.8 * 5 = 4
    expect(flags.get("E fine")).toBe("none");
    expect(flags.get("F very rotten")).toBe("red");

    const days = new Map(
      board.stages.flatMap((s) => s.deals.map((d) => [d.title, d.days_in_stage] as const)),
    );
    expect(days.get("B at boundary")).toBe(1);
    expect(days.get("F very rotten")).toBe(6);
  });

  it("never rots NULL rot_days stages and resolves linked display names", async () => {
    const db = testDb();
    const { A } = await seedBoard(db);
    const leads = await pipelineBoard(db, { pipeline: "New Leads - Wine", now: NOW });
    const lead = leads.stages[0]!.deals[0]!;
    expect(lead.title).toBe("L old lead");
    expect(lead.days_in_stage).toBe(100);
    expect(lead.rotting).toBe("none");

    const board = await pipelineBoard(db, { pipeline: 1, now: NOW });
    const a = board.stages[0]!.deals.find((d) => d.id === (A["id"] as number))!;
    expect(a.organization).toBe("Berlin Wein Kontor");
    expect(a.contact).toBe("Hans Keller");
    expect(a.owner).toBe("Sodimo Admin");
  });

  it("attaches the earliest pending activity as next_activity (done ones never)", async () => {
    const db = testDb();
    const { A, B } = await seedBoard(db);
    const board = await pipelineBoard(db, { pipeline: "Export Clients", now: NOW });
    const byId = new Map(board.stages.flatMap((s) => s.deals.map((d) => [d.id, d])));

    const a = byId.get(A["id"] as number)!;
    expect(a.next_activity).toMatchObject({
      subject: "next follow-up",
      due_date: "2026-06-13",
      due_time: null,
    });
    expect(byId.get(B["id"] as number)!.next_activity).toBeNull();
  });
});

describe("overdue_activities", () => {
  async function seedOverdue(db: Db) {
    const raniId = await createUser(db, "Rani Bou Acar", "rani@sodimo.eu");
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Tardy Trading" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const d = await deal(db, { title: "Slow deal", organization: org["id"] as number, value: 100 });

    const acts = (await createRecord(
      db,
      {
        entity: "activity",
        data: [
          { subject: "two days late", activity_type: "call", due_date: "2026-06-10", deal: d["id"] as number, organization: org["id"] as number },
          { subject: "today untimed", activity_type: "task", due_date: "2026-06-12" },
          { subject: "this morning", activity_type: "meeting", due_date: "2026-06-12", due_time: "08:00" },
          { subject: "tonight", activity_type: "call", due_date: "2026-06-12", due_time: "23:00" },
          { subject: "old but done", activity_type: "email", due_date: "2026-06-01" },
          { subject: "rani backlog", activity_type: "task", due_date: "2026-05-30", assignee: raniId },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    await completeActivity(db, { activity: acts[4]!["id"] as number, now: NOW }, admin);
    return { raniId, org, d };
  }

  it("returns pending activities with due date/time in the past, oldest first", async () => {
    const db = testDb();
    await seedOverdue(db);
    const r = await overdueActivities(db, { now: NOW }); // now time = 10:00
    expect(r.map((a) => a.subject)).toEqual(["rani backlog", "two days late", "this morning"]);

    const first = r.find((a) => a.subject === "two days late")!;
    expect(first.deal).toBe("Slow deal");
    expect(first.organization).toBe("Tardy Trading");
    expect(first.assignee).toBe("Sodimo Admin");
  });

  it("filters by assignee, resolved by name", async () => {
    const db = testDb();
    await seedOverdue(db);
    const r = await overdueActivities(db, { assignee: "Rani Bou Acar", now: NOW });
    expect(r.map((a) => a.subject)).toEqual(["rani backlog"]);
    expect(r[0]!.assignee).toBe("Rani Bou Acar");
  });
});

describe("no_next_activity", () => {
  it("returns open deals with zero pending activities", async () => {
    const db = testDb();
    const naked = await deal(db, { title: "Naked deal", value: 100 });
    const doneOnly = await deal(db, { title: "Done-only deal", value: 100 });
    const covered = await deal(db, { title: "Covered deal", value: 100 });
    const wonBare = await deal(db, { title: "Won bare deal", value: 100 });
    await moveDeal(db, { deal: wonBare["id"] as number, status: "won", now: NOW }, admin);
    const archivedBare = await deal(db, { title: "Archived bare deal", value: 100 });
    await archiveRecord(db, { entity: "deal", id: archivedBare["id"] as number, now: NOW }, admin);
    await deal(db, { title: "Naked lead", pipeline: "New Leads - Wine", value: 100 });

    const acts = (await createRecord(
      db,
      {
        entity: "activity",
        data: [
          { subject: "covering", activity_type: "call", due_date: "2026-06-15", deal: covered["id"] as number },
          { subject: "finished", activity_type: "call", due_date: "2026-06-01", deal: doneOnly["id"] as number },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    await completeActivity(db, { activity: acts[1]!["id"] as number, now: NOW }, admin);

    const all = await noNextActivity(db, { now: NOW });
    expect(all.map((d) => d.title)).toEqual(["Naked deal", "Done-only deal", "Naked lead"]);
    expect(all[0]!.id).toBe(naked["id"] as number);
    expect(all[0]!.pipeline).toBe("Export Clients");
    expect(all[0]!.stage).toBe("Order received");

    const exportOnly = await noNextActivity(db, { pipeline: "Export Clients", now: NOW });
    expect(exportOnly.map((d) => d.title)).toEqual(["Naked deal", "Done-only deal"]);
  });
});

describe("stale_deals", () => {
  it("returns red+amber deals, red first, by days_in_stage desc", async () => {
    const db = testDb();
    await seedBoard(db);
    const r = await staleDeals(db, { pipeline: "Export Clients", now: NOW });
    expect(r.map((d) => [d.title, d.rotting, d.days_in_stage])).toEqual([
      ["F very rotten", "red", 6],
      ["C rotten", "red", 2],
      ["D amber boundary", "amber", 4],
      ["B at boundary", "amber", 1],
    ]);
    expect(r[0]!.stage).toBe("Waiting for delivery");
    expect(r[0]!.rot_days).toBe(5);
  });

  it("never includes NULL-rot pipelines, won or archived deals", async () => {
    const db = testDb();
    await seedBoard(db);
    const r = await staleDeals(db, { now: NOW }); // all pipelines
    const titles = r.map((d) => d.title);
    expect(titles).not.toContain("L old lead"); // 100 days, but never rots
    expect(titles).not.toContain("G won");
    expect(titles).not.toContain("H archived");
    expect(titles).toHaveLength(4);
  });
});

describe("recent_activity", () => {
  it("returns events in the window, newest first, with display names and parsed payloads", async () => {
    const db = testDb();
    await createRecord(
      db,
      { entity: "organization", data: { name: "Ancient Org" }, now: daysAgo(10) },
      admin,
    );
    const fresh = (await createRecord(
      db,
      { entity: "organization", data: { name: "Fresh Org" }, now: NOW },
      admin,
    )) as ServiceRecord;
    await updateRecord(
      db,
      { entity: "organization", id: fresh["id"] as number, patch: { category: "importer" }, now: NOW },
      admin,
    );

    const r = await recentActivity(db, { days: 7, now: NOW });
    expect(r.map((e) => e.kind)).toEqual(["updated", "created"]); // id desc on equal timestamps
    expect(r.every((e) => e.entity_label === "Fresh Org")).toBe(true);
    expect(r.every((e) => e.actor === "Sodimo Admin")).toBe(true);
    expect(r[0]!.payload).toMatchObject({ changes: { category: { to: "importer" } } });

    // widening the window pulls the old event back in
    const wide = await recentActivity(db, { days: 30, now: NOW });
    expect(wide.map((e) => e.entity_label)).toContain("Ancient Org");
  });

  it("rejects a non-positive window", async () => {
    const db = testDb();
    await expect(recentActivity(db, { days: 0, now: NOW })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("my_day", () => {
  async function seedDay(db: Db) {
    const raniId = await createUser(db, "Rani Bou Acar", "rani@sodimo.eu");
    const org = (await createRecord(
      db,
      { entity: "organization", data: { name: "Day Org" }, now: NOW },
      admin,
    )) as ServiceRecord;
    const d = await deal(db, { title: "Day deal", organization: org["id"] as number, value: 100 });

    const acts = (await createRecord(
      db,
      {
        entity: "activity",
        data: [
          { subject: "morning call", activity_type: "call", due_date: "2026-06-12", due_time: "09:00", assignee: raniId, deal: d["id"] as number },
          { subject: "afternoon meeting", activity_type: "meeting", due_date: "2026-06-12", due_time: "14:00", assignee: raniId },
          { subject: "sometime today", activity_type: "task", due_date: "2026-06-12", assignee: raniId },
          { subject: "late morning done", activity_type: "call", due_date: "2026-06-12", due_time: "11:00", assignee: raniId },
          { subject: "tomorrow", activity_type: "task", due_date: "2026-06-13", assignee: raniId },
          { subject: "missed it", activity_type: "task", due_date: "2026-06-10", assignee: raniId },
          { subject: "not mine", activity_type: "task", due_date: "2026-06-12", assignee: 1 },
        ],
        now: NOW,
      },
      admin,
    )) as ServiceRecord[];
    await completeActivity(db, { activity: acts[3]!["id"] as number, now: NOW }, admin);
    return { raniId, d };
  }

  it("defaults to today from `now`, orders by due_time with NULLs last", async () => {
    const db = testDb();
    const { raniId, d } = await seedDay(db);
    const r = await myDay(db, { user: "Rani Bou Acar", now: NOW });

    expect(r.user).toEqual({ id: raniId, name: "Rani Bou Acar" });
    expect(r.date).toBe("2026-06-12");
    expect(r.items.map((i) => i.subject)).toEqual([
      "morning call",
      "late morning done",
      "afternoon meeting",
      "sometime today",
    ]);
    expect(r.items[1]!.done).toBe(true); // done items stay on the agenda, flagged
    expect(r.items[0]!.deal).toBe(d["title"]);
    expect(r.items[0]!.organization).toBeNull(); // linked via deal, not directly
    expect(r.overdue_count).toBe(1); // "missed it"
  });

  it("accepts an explicit date and counts overdue relative to it", async () => {
    const db = testDb();
    const { raniId } = await seedDay(db);
    const r = await myDay(db, { user: raniId, date: "2026-06-13", now: NOW });
    expect(r.items.map((i) => i.subject)).toEqual(["tomorrow"]);
    // pending before 06-13: missed it, morning call, afternoon meeting, sometime today
    expect(r.overdue_count).toBe(4);
  });

  it("rejects malformed dates and unknown users", async () => {
    const db = testDb();
    await expect(myDay(db, { user: 1, date: "13/06/2026", now: NOW })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(myDay(db, { user: "nobody such", now: NOW })).rejects.toThrow(/user/i);
  });
});
