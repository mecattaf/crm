// Hash a password the way the CRM stores it (WebCrypto PBKDF2-SHA256).
// Usage: node scripts/hash-password.mjs <password> [salt_b64]
// Output format: pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>
// Used to produce the literal in drizzle/migrations/0001_seed.sql; issue #6's
// login verifier must parse this same format.

const ITERATIONS = 600_000;

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs <password> [salt_b64]");
  process.exit(1);
}

const salt = process.argv[3]
  ? Buffer.from(process.argv[3], "base64")
  : crypto.getRandomValues(new Uint8Array(16));

const key = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"],
);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
  key,
  256,
);

const saltB64 = Buffer.from(salt).toString("base64");
const hashB64 = Buffer.from(bits).toString("base64");
console.log(`pbkdf2-sha256$${ITERATIONS}$${saltB64}$${hashB64}`);
