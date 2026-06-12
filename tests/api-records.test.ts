import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServiceRecord } from "../src/server/services/types";
import { BASE, apiFetch, apiJson, loginCookie } from "./helpers/session";

/** REST CRUD adapters over the record services (issue #7). */

let cookie: string;
beforeEach(async () => {
  cookie = await loginCookie();
});

type ListBody = { data: ServiceRecord[]; cursor?: string };

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe("entity CRUD round-trips", () => {
  it("organizations: create, get (+include), patch, list", async () => {
    const created = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/organizations",
      { name: "Château Margaux Négoce", category: "Wine" },
      201,
    );
    expect(created["name"]).toBe("Château Margaux Négoce");
    expect(created["name_norm"]).toBeUndefined();
    const id = created.id;

    const got = await apiJson<ServiceRecord>(cookie, "GET", `/organizations/${id}`, undefined, 200);
    expect(got["category"]).toBe("Wine");

    const withInclude = await apiJson<ServiceRecord>(
      cookie,
      "GET",
      `/organizations/${id}?include=contacts,timeline`,
      undefined,
      200,
    );
    expect(withInclude["contacts"]).toEqual([]);
    const timeline = withInclude["timeline"] as { type: string; data: { kind?: string } }[];
    expect(timeline.some((t) => t.type === "event" && t.data.kind === "created")).toBe(true);

    const patched = await apiJson<ServiceRecord>(
      cookie,
      "PATCH",
      `/organizations/${id}`,
      { category: "Négociant" },
      200,
    );
    expect(patched["category"]).toBe("Négociant");

    const list = await apiJson<ListBody>(cookie, "GET", "/organizations", undefined, 200);
    expect(list.data.map((r) => r.id)).toContain(id);
    expect(list.cursor).toBeUndefined();
  });

  it("contacts: name refs resolve on create; patch round-trips", async () => {
    await apiJson(cookie, "POST", "/organizations", { name: "Swiss Fine Wines" }, 201);
    const contact = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/contacts",
      { first_name: "Léa", last_name: "Dubois", organization: "Swiss Fine Wines" },
      201,
    );
    expect(typeof contact["org_id"]).toBe("number");

    const patched = await apiJson<ServiceRecord>(
      cookie,
      "PATCH",
      `/contacts/${contact.id}`,
      { job_title: "Buyer" },
      200,
    );
    expect(patched["job_title"]).toBe("Buyer");
  });

  it("deals: decimal money in/out, pipeline+stage by name", async () => {
    const deal = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/deals",
      {
        title: "Bordeaux Q3 order",
        pipeline: "Export Clients",
        stage: "Proforma Sent",
        value: 1234.5,
        currency: "EUR",
      },
      201,
    );
    expect(deal["value"]).toBe(1234.5);
    expect(deal["value_cents"]).toBeUndefined();
    expect(deal["status"]).toBe("open");

    const patched = await apiJson<ServiceRecord>(
      cookie,
      "PATCH",
      `/deals/${deal.id}`,
      { value: 2000 },
      200,
    );
    expect(patched["value"]).toBe(2000);
  });

  it("activities: create and patch", async () => {
    const act = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/activities",
      { subject: "Call Rani", activity_type: "call", due_date: isoDate(1) },
      201,
    );
    expect(act["assignee_id"]).toBe(1); // defaults to the actor
    const patched = await apiJson<ServiceRecord>(
      cookie,
      "PATCH",
      `/activities/${act.id}`,
      { priority: "high" },
      200,
    );
    expect(patched["priority"]).toBe("high");
  });

  it("notes: require a link; author defaults to the actor", async () => {
    const org = await apiJson<ServiceRecord>(cookie, "POST", "/organizations", { name: "London Cellars" }, 201);
    const note = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      "/notes",
      { body: "Wants the 2019 vintage", organization: org.id },
      201,
    );
    expect(note["author_id"]).toBe(1);
    expect(note["org_id"]).toBe(org.id);

    const patched = await apiJson<ServiceRecord>(
      cookie,
      "PATCH",
      `/notes/${note.id}`,
      { body: "Wants the 2019 vintage — 60 cases" },
      200,
    );
    expect(patched["body"]).toContain("60 cases");

    const res = await apiFetch(cookie, "POST", "/notes", { body: "floating note" });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain("at least one of");
  });
});

describe("filter grammar via query params", () => {
  it("typed filters, sort and keyset cursor", async () => {
    await apiJson(
      cookie,
      "POST",
      "/deals",
      [
        { title: "Small", value: 100 },
        { title: "Medium", value: 200 },
        { title: "Large", value: 300 },
      ],
      201,
    );

    const page1 = await apiJson<ListBody>(
      cookie,
      "GET",
      "/deals?filter=value:gte:150&sort=-value&limit=1",
      undefined,
      200,
    );
    expect(page1.data.map((d) => d["title"])).toEqual(["Large"]);
    expect(page1.cursor).toBeDefined();

    const page2 = await apiJson<ListBody>(
      cookie,
      "GET",
      `/deals?filter=value:gte:150&sort=-value&limit=1&cursor=${encodeURIComponent(page1.cursor!)}`,
      undefined,
      200,
    );
    expect(page2.data.map((d) => d["title"])).toEqual(["Medium"]);
  });

  it("relative-date operand in_next_days through the query string", async () => {
    await apiJson(
      cookie,
      "POST",
      "/activities",
      [
        { subject: "due soon", activity_type: "task", due_date: isoDate(2) },
        { subject: "due far", activity_type: "task", due_date: isoDate(30) },
      ],
      201,
    );
    const soon = await apiJson<ListBody>(
      cookie,
      "GET",
      "/activities?filter=due_date:in_next_days:7",
      undefined,
      200,
    );
    expect(soon.data.map((a) => a["subject"])).toEqual(["due soon"]);
  });

  it("query= fuzzy accent-insensitive match", async () => {
    await apiJson(cookie, "POST", "/organizations", { name: "Château Margaux Négoce" }, 201);
    const hits = await apiJson<ListBody>(
      cookie,
      "GET",
      "/organizations?query=margaux%20negoce",
      undefined,
      200,
    );
    expect(hits.data.map((o) => o["name"])).toEqual(["Château Margaux Négoce"]);
  });

  it("unknown field and malformed filter param → 400", async () => {
    const unknown = await apiFetch(cookie, "GET", "/deals?filter=bogus:eq:1");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('Unknown field "bogus"');

    const malformed = await apiFetch(cookie, "GET", "/deals?filter=justafield");
    expect(malformed.status).toBe(400);
  });
});

describe("batch create and bulk patch", () => {
  it("POST array body → {data: [...]} with every record created", async () => {
    const body = await apiJson<ListBody>(
      cookie,
      "POST",
      "/contacts",
      [
        { first_name: "Anna", last_name: "Keller" },
        { first_name: "Marc", last_name: "Petit" },
      ],
      201,
    );
    expect(body.data).toHaveLength(2);
    expect(body.data.every((r) => typeof r.id === "number")).toBe(true);
  });

  it("PATCH collection with [{id, patch}] updates heterogeneously", async () => {
    const created = await apiJson<ListBody>(
      cookie,
      "POST",
      "/deals",
      [
        { title: "Bulk A", value: 10 },
        { title: "Bulk B", value: 20 },
      ],
      201,
    );
    const [a, b] = created.data;
    const updated = await apiJson<ListBody>(
      cookie,
      "PATCH",
      "/deals",
      [
        { id: a!.id, patch: { label: "hot" } },
        { id: b!.id, patch: { value: 99.5 } },
      ],
      200,
    );
    expect(updated.data[0]!["label"]).toBe("hot");
    expect(updated.data[1]!["value"]).toBe(99.5);

    const res = await apiFetch(cookie, "PATCH", "/deals", { id: a!.id, patch: {} });
    expect(res.status).toBe(400); // bulk PATCH requires an array
  });
});

describe("archive and confirm-gated delete", () => {
  it("archive hides the record from default lists; include_archived reveals it", async () => {
    const org = await apiJson<ServiceRecord>(cookie, "POST", "/organizations", { name: "Old Partner" }, 201);
    const archived = await apiJson<ServiceRecord>(
      cookie,
      "POST",
      `/organizations/${org.id}/archive`,
      undefined,
      200,
    );
    expect(archived["archived_at"]).not.toBeNull();

    const dflt = await apiJson<ListBody>(cookie, "GET", "/organizations", undefined, 200);
    expect(dflt.data.map((o) => o.id)).not.toContain(org.id);

    const all = await apiJson<ListBody>(
      cookie,
      "GET",
      "/organizations?include_archived=true",
      undefined,
      200,
    );
    expect(all.data.map((o) => o.id)).toContain(org.id);
  });

  it("DELETE without confirm → 409; with confirm=true → 200, then 404", async () => {
    const org = await apiJson<ServiceRecord>(cookie, "POST", "/organizations", { name: "Typo Org" }, 201);

    const blocked = await apiFetch(cookie, "DELETE", `/organizations/${org.id}`);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain("confirm=true");

    const deleted = await apiJson<{ deleted: boolean; record: ServiceRecord }>(
      cookie,
      "DELETE",
      `/organizations/${org.id}?confirm=true`,
      undefined,
      200,
    );
    expect(deleted.deleted).toBe(true);
    expect(deleted.record.id).toBe(org.id);

    const gone = await apiFetch(cookie, "GET", `/organizations/${org.id}`);
    expect(gone.status).toBe(404);
  });
});

describe("error conventions", () => {
  it("ambiguous name ref → 400 with candidates", async () => {
    await apiJson(
      cookie,
      "POST",
      "/organizations",
      [{ name: "Alpha Wines" }, { name: "Alpha Wines Reserve" }],
      201,
    );
    const res = await apiFetch(cookie, "GET", "/organizations/alpha");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; candidates: { id: number }[] };
    expect(body.candidates).toHaveLength(2);
  });

  it("service zod validation surfaces as 400 {error}", async () => {
    const res = await apiFetch(cookie, "POST", "/organizations", { nom: "wrong field" });
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  it("PATCH deal stage/status is rejected toward move_deal", async () => {
    const deal = await apiJson<ServiceRecord>(cookie, "POST", "/deals", { title: "Guarded" }, 201);
    const res = await apiFetch(cookie, "PATCH", `/deals/${deal.id}`, { status: "won" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("move_deal");
  });

  it("missing record → 404", async () => {
    const res = await apiFetch(cookie, "GET", "/deals/99999");
    expect(res.status).toBe(404);
  });
});

describe("auth guard", () => {
  it("401 JSON without a session cookie across the surface", async () => {
    for (const [method, path] of [
      ["GET", "/api/deals"],
      ["POST", "/api/organizations"],
      ["GET", "/api/workspace"],
      ["GET", "/api/views/pipeline_board?pipeline=Export%20Clients"],
      ["POST", "/api/deals/1/move"],
    ] as const) {
      const res = await SELF.fetch(`${BASE}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await res.json()) as object).toEqual({ error: "unauthenticated" });
    }
  });
});
