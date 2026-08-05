import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  getEncryptionKey,
  isEncrypted,
  isEncryptionConfigured,
  safeEqual,
} from "../src/lib/crypto";

/**
 * Credential-at-rest tests (spec §5, Phase-5 brief §5). The acceptance check is
 * "tokens in the DB are encrypted — no readable token", so the assertions here
 * are mostly about what must NOT be present in the stored value.
 */

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY_HEX = Buffer.alloc(32, 9).toString("hex");

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_B64;
});

describe("getEncryptionKey", () => {
  it("accepts a base64 32-byte key", () => {
    expect(getEncryptionKey()).toHaveLength(32);
  });

  it("accepts a hex 32-byte key", () => {
    process.env.ENCRYPTION_KEY = KEY_HEX;
    expect(getEncryptionKey()).toHaveLength(32);
  });

  it("refuses a missing key rather than falling back to a weak one", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => getEncryptionKey()).toThrow(/ENCRYPTION_KEY is not set/);
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("refuses a key of the wrong length", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => getEncryptionKey()).toThrow(/must decode to 32 bytes/);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a token", () => {
    const token = "atlassian-refresh-token-abc123";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("never leaves the plaintext readable in the stored value", () => {
    const token = "super-secret-tempo-token";
    const stored = encryptSecret(token);
    expect(stored).not.toContain(token);
    expect(Buffer.from(stored).includes(token)).toBe(false);
    expect(isEncrypted(stored)).toBe(true);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const stored = encryptSecret("tamper-me");
    const parts = stored.split(".");
    // Flip a byte of the ciphertext segment.
    const data = Buffer.from(parts[3]!, "base64url");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });

  it("rejects a ciphertext encrypted under a different key", () => {
    const stored = encryptSecret("cross-key");
    process.env.ENCRYPTION_KEY = KEY_HEX;
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("rejects a value that is not in the v1 envelope format", () => {
    expect(() => decryptSecret("plain-token")).toThrow(/v1 envelope/);
    expect(isEncrypted("plain-token")).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe("encryptJson / decryptJson", () => {
  it("round-trips a credential bundle as one opaque ciphertext", () => {
    const bundle = {
      accessToken: "at-1234",
      refreshToken: "rt-5678",
      scope: "read:jira-work offline_access",
    };
    const stored = encryptJson(bundle);
    expect(decryptJson<typeof bundle>(stored)).toEqual(bundle);
    // The row must leak neither the values nor the field names.
    expect(stored).not.toContain("rt-5678");
    expect(stored).not.toContain("refreshToken");
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal values", () => {
    expect(safeEqual("state-abc", "state-abc")).toBe(true);
    expect(safeEqual("state-abc", "state-abd")).toBe(false);
  });

  it("returns false on length mismatch without throwing", () => {
    expect(safeEqual("short", "much-longer-value")).toBe(false);
  });
});
