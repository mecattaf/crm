import { describe, expect, it } from "vitest";
import { normalizeText } from "../src/server/services/normalize";

describe("normalizeText", () => {
  it("strips accents", () => {
    expect(normalizeText("Müller Café")).toBe("muller cafe");
    expect(normalizeText("Château Margaux")).toBe("chateau margaux");
    expect(normalizeText("Sémillon-Crémant")).toBe("semillon-cremant");
  });

  it("lowercases", () => {
    expect(normalizeText("EXPORT CLIENTS")).toBe("export clients");
  });

  it("trims and collapses whitespace", () => {
    expect(normalizeText("  Hôtel   de   Ville ")).toBe("hotel de ville");
  });

  it("is idempotent", () => {
    const once = normalizeText("Genève Spiritueux");
    expect(normalizeText(once)).toBe(once);
  });
});
