import { describe, expect, it } from "vitest";
import {
  resolveContact,
  resolveOrganization,
  resolvePipeline,
  resolveStage,
  resolveUser,
} from "../src/server/services/resolve";
import { AmbiguousError, NotFoundError } from "../src/server/services/errors";
import { createRecord } from "../src/server/services/records";
import { NOW, admin, testDb } from "./helpers";

describe("name resolution", () => {
  it("resolves a pipeline by id, numeric string, exact and partial name (accent-insensitive)", async () => {
    const db = testDb();
    expect((await resolvePipeline(db, 1)).name).toBe("Export Clients");
    expect((await resolvePipeline(db, "1")).name).toBe("Export Clients");
    expect((await resolvePipeline(db, "EXPORT CLIENTS")).name).toBe("Export Clients");
    expect((await resolvePipeline(db, "export")).name).toBe("Export Clients");
    expect((await resolvePipeline(db, "new leads")).name).toBe("New Leads - Wine");
  });

  it("resolves stages within one pipeline only", async () => {
    const db = testDb();
    const payment = await resolveStage(db, "payment", 1);
    expect(payment.id).toBe(4);
    expect(payment.forecast_weight).toBe(100);
    await expect(resolveStage(db, "qualification", 1)).rejects.toBeInstanceOf(NotFoundError);
    expect((await resolveStage(db, "qualification", 2)).pipeline_id).toBe(2);
  });

  it("raises AmbiguousError with candidates on multiple stage matches", async () => {
    const db = testDb();
    const err = await resolveStage(db, "proforma", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousError);
    expect((err as AmbiguousError).candidates.map((c) => c.label).sort()).toEqual([
      "Proforma Sent",
      "Proforma confirmed",
    ]);
  });

  it("resolves users by email, name, and id", async () => {
    const db = testDb();
    expect((await resolveUser(db, "admin@sodimo.eu")).id).toBe(1);
    expect((await resolveUser(db, "Sodimo Admin")).id).toBe(1);
    expect((await resolveUser(db, 1)).email).toBe("admin@sodimo.eu");
    await expect(resolveUser(db, "nobody@example.com")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves organizations accent-insensitively and reports ambiguity", async () => {
    const db = testDb();
    await createRecord(
      db,
      {
        entity: "organization",
        data: [{ name: "Château Margaux Distribution" }, { name: "Château Latour Imports" }],
        now: NOW,
      },
      admin,
    );
    expect((await resolveOrganization(db, "chateau margaux distribution")).name).toBe(
      "Château Margaux Distribution",
    );
    const err = await resolveOrganization(db, "chateau").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousError);
    expect((err as AmbiguousError).candidates).toHaveLength(2);
    expect((err as AmbiguousError).message).toContain("Château Latour Imports");
  });

  it("resolves contacts by full name or last name", async () => {
    const db = testDb();
    await createRecord(
      db,
      { entity: "contact", data: { first_name: "Marie", last_name: "Dupont" }, now: NOW },
      admin,
    );
    expect((await resolveContact(db, "Marie Dupont")).last_name).toBe("Dupont");
    expect((await resolveContact(db, "dupont")).first_name).toBe("Marie");
    await expect(resolveContact(db, "ghost")).rejects.toBeInstanceOf(NotFoundError);
  });
});
