import { randomBytes, randomInt } from "node:crypto";

/**
 * Device-flow code generation (spec §4.3). Kept separate from route handlers so
 * the shapes are easy to reason about and unit-test.
 */

/** Lifetime of a device authorization before it expires. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** Poll interval the CLI should respect. */
export const DEVICE_POLL_INTERVAL_SECONDS = 3;

/** Opaque, high-entropy secret the CLI polls with. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

// Crockford-ish alphabet: no 0/O/1/I to keep the human-typed code unambiguous.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Short human-entered code, e.g. `WDJB-MJHT`. */
export function generateUserCode(): string {
  const pick = () =>
    Array.from({ length: 4 }, () =>
      USER_CODE_ALPHABET.charAt(randomInt(USER_CODE_ALPHABET.length)),
    ).join("");
  return `${pick()}-${pick()}`;
}
