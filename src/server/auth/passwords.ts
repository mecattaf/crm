/**
 * PBKDF2-SHA256 password hashing via WebCrypto.
 *
 * Stored format (must stay in sync with scripts/hash-password.mjs and the
 * seeded admin in drizzle/migrations/0001_seed.sql):
 *
 *   pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>
 */

const ALGORITHM = "pbkdf2-sha256";
const DEFAULT_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Constant-time byte comparison (no early exit on mismatch). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Hash a password with a fresh random salt. */
export async function hashPassword(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${b64encode(salt)}$${b64encode(hash)}`;
}

/** Verify a password against a stored hash string. Never throws on malformed input. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64decode(parts[2] as string);
    expected = b64decode(parts[3] as string);
  } catch {
    return false;
  }
  const actual = await derive(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}
