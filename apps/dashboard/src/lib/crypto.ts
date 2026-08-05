import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for outbound credentials at rest (spec §5, Phase-5 brief
 * §5). Jira/Tempo tokens are the one class of secret we must be able to *read*
 * back — unlike agent tokens, which are hashed and never recovered — so they are
 * encrypted with AES-256-GCM under a key held only in the server environment.
 *
 * Constraint 3 (spec §2): these ciphertexts never leave the server. Nothing in
 * this module logs plaintext, and callers must not either.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const VERSION = "v1";

/**
 * Read + validate ENCRYPTION_KEY. Accepts base64 (`openssl rand -base64 32`) or
 * hex; both must decode to exactly 32 bytes. Throws loudly rather than falling
 * back to a weak key — a silent downgrade here would be worse than an outage.
 */
export function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set — required to store Jira/Tempo credentials. Generate one with: openssl rand -base64 32",
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** True when a usable ENCRYPTION_KEY is configured — for UI gating, not security. */
export function isEncryptionConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a UTF-8 string. Output is `v1.<iv>.<authTag>.<ciphertext>`, all
 * base64url — self-describing so the format can rotate without a data migration.
 */
export function encryptSecret(plaintext: string, key = getEncryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a value produced by `encryptSecret`. Throws on tampering (GCM auth
 * tag mismatch) or an unknown version — never returns a partial/garbled result.
 */
export function decryptSecret(encoded: string, key = getEncryptionKey()): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("ciphertext is not in the expected v1 envelope format");
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** True if `value` looks like one of our envelopes (used to spot plaintext rows). */
export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.split(".").length === 4 &&
    value.startsWith(`${VERSION}.`);
}

/**
 * Encrypt an arbitrary JSON-serialisable credential bundle into a single
 * envelope string. The whole bundle is one ciphertext (rather than per-field)
 * so the DB row leaks nothing about token shape or presence.
 */
export function encryptJson(value: unknown, key = getEncryptionKey()): string {
  return encryptSecret(JSON.stringify(value), key);
}

export function decryptJson<T = unknown>(
  encoded: string,
  key = getEncryptionKey(),
): T {
  return JSON.parse(decryptSecret(encoded, key)) as T;
}

/** Constant-time string compare, for OAuth `state` verification. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
