import { beforeEach, describe, expect, it } from "vitest";
import type { ServiceRecord } from "../src/server/services/types";
import { apiFetch, apiJson, loginCookie } from "./helpers/session";

/** Deal-move and activity-complete verb endpoints (issue #7). */

let cookie: string;
beforeEach(async () => {
  cookie = await loginCookie();
});

async function createDeal(title: string): Promise<ServiceRecord> {
  return apiJson<ServiceRecord>(
    cookie,
    "POST",
    "/deals",
    { title, pipeline: "Export Clients", stage: "Order received", value: 500 },
    201,
  );
}

describe("POST /api/deals/:id/move", () => {
  it("moves stage by name and then closes won", async () => {
    const deal = await createDeal("Move me");

    const moved = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      `/deals/${deal.id}/move`,
      { stage: "Payment" },
      200,
    );
    expect(moved["stage_id"]).not.toBe(deal["stage_id"]);
    expect(moved["status"]).toBe("open");

    const won = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      `/deals/${deal.id}/move`,
      { status: "won" },
      200,
    );
    expect(won["status"]).toBe("won");
    expect(won["won_at"]).not.toBeNull();
  });

  it("records lost with a reason", async () => {
    const deal = await createDeal("Lose me");
    const lost = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      `/deals/${deal.id}/move`,
      { status: "lost", lost_reason: "price" },
      200,
    );
    expect(lost["status"]).toBe("lost");
    expect(lost["lost_reason"]).toBe("price");
  });

  it("validates the body: empty, bad status, stray lost_reason", async () => {
    const deal = await createDeal("Validate me");

    const empty = await apiFetch(cookie, "POST", `/deals/${deal.id}/move`, {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain("stage and/or a status");

    const badStatus = await apiFetch(cookie, "POST", `/deals/${deal.id}/move`, { status: "banana" });
    expect(badStatus.status).toBe(400);

    const strayReason = await apiFetch(cookie, "POST", `/deals/${deal.id}/move`, {
      stage: "Payment",
      lost_reason: "nope",
    });
    expect(strayReason.status).toBe(400);
  });

  it("404s on a missing deal", async () => {
    const res = await apiFetch(cookie, "POST", "/deals/99999/move", { stage: "Payment" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/activities/:id/complete", () => {
  async function createActivity(subject: string): Promise<ServiceRecord> {
    return apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/activities",
      { subject, activity_type: "call", due_date: "2026-06-15", note: "agenda" },
      201,
    );
  }

  it("completes with a done_note appended to the note", async () => {
    const act = await createActivity("Call buyer");
    const done = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      `/activities/${act.id}/complete`,
      { done_note: "left voicemail" },
      200,
    );
    expect(done["done"]).toBe(true);
    expect(done["done_at"]).not.toBeNull();
    expect(done["note"]).toBe("agenda\nleft voicemail");
  });

  it("completes with an empty body and rejects double completion", async () => {
    const act = await createActivity("Quick task");
    const res = await apiFetch(cookie, "POST", `/activities/${act.id}/complete`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ServiceRecord)["done"]).toBe(true);

    const again = await apiFetch(cookie, "POST", `/activities/${act.id}/complete`, {});
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain("already done");
  });
});
