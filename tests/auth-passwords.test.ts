import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/server/auth/passwords";
import { testDb } from "./helpers";
import { schema } from "../src/server/db";
import { eq } from "drizzle-orm";

// Cheap iteration count for most round-trip cases; format is identical.
const FAST = 1_000;

describe("password hash/verify", () => {
  it("round-trips: hash then verify succeeds", async () => {
    const stored = await hashPassword("s3cret-Pässword!", FAST);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("s3cret-Pässword!", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse", FAST);
    expect(await verifyPassword("battery staple", stored)).toBe(false);
  });

  it("rejects a tampered hash (flipped digest byte)", async () => {
    const stored = await hashPassword("correct horse", FAST);
    const parts = stored.split("$");
    const digest = atob(parts[3] as string);
    const flipped = String.fromCharCode(digest.charCodeAt(0) ^ 0xff) + digest.slice(1);
    parts[3] = btoa(flipped);
    expect(await verifyPassword("correct horse", parts.join("$"))).toBe(false);
  });

  it("rejects a tampered salt", async () => {
    const stored = await hashPassword("correct horse", FAST);
    const parts = stored.split("$");
    parts[2] = btoa("0123456789abcdef");
    expect(await verifyPassword("correct horse", parts.join("$"))).toBe(false);
  });

  it("rejects malformed stored values without throwing", async () => {
    for (const bad of [
      "",
      "plaintext",
      "pbkdf2-sha256$600000$onlythreeparts",
      "pbkdf2-sha512$1000$AAAA$AAAA", // wrong algorithm tag
      "pbkdf2-sha256$NaN$AAAA$AAAA", // bad iteration count
      "pbkdf2-sha256$1000$!!notb64!!$AAAA", // invalid base64
    ]) {
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
  });

  it("verifies the seeded admin hash with the documented password (full 600k iterations)", async () => {
    const db = testDb();
    const admin = await db.select().from(schema.users).where(eq(schema.users.id, 1)).get();
    expect(admin).toBeDefined();
    expect(await verifyPassword("changeme-sodimo", admin!.password_hash)).toBe(true);
    expect(await verifyPassword("wrong-password", admin!.password_hash)).toBe(false);
  });
});
