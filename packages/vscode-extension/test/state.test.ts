import { describe, expect, it } from "vitest";
import type { DevpulseStatus } from "@devpulse/setup";
import {
  deriveSetupState,
  factsFromStatus,
  partialReason,
  setupStateFromStatus,
} from "../src/lib/state";

/**
 * Acceptance (brief §6): "unit tests for any pure logic added (state
 * detection)". These encode when the extension believes telemetry is actually
 * flowing — the same question `devpulse-setup status` answers.
 */

const OURS = "/home/dev/.devpulse/hooks";

function status(overrides: Partial<DevpulseStatus> = {}): DevpulseStatus {
  return {
    home: "/home/dev/.devpulse",
    credentials: { token: "t", baseUrl: "https://dash.example", label: "laptop" },
    hooksPath: OURS,
    hooksPathIsOurs: true,
    chainedHooksPath: null,
    hooks: ["post-commit", "post-checkout", "pre-push"],
    spoolCount: 0,
    lastSend: null,
    ...overrides,
  };
}

describe("deriveSetupState", () => {
  it("is active only when a token exists AND our hooks are live", () => {
    expect(
      deriveSetupState({
        hasCredentials: true,
        hooksPathIsOurs: true,
        hookScriptsPresent: true,
      }),
    ).toBe("active");
  });

  it("is not-installed on a fresh machine", () => {
    expect(
      deriveSetupState({
        hasCredentials: false,
        hooksPathIsOurs: false,
        hookScriptsPresent: false,
      }),
    ).toBe("not-installed");
  });

  it("is partial when a token exists but hooks are not live", () => {
    expect(
      deriveSetupState({
        hasCredentials: true,
        hooksPathIsOurs: false,
        hookScriptsPresent: true,
      }),
    ).toBe("partial");
    expect(
      deriveSetupState({
        hasCredentials: true,
        hooksPathIsOurs: true,
        hookScriptsPresent: false,
      }),
    ).toBe("partial");
  });

  it("is partial when hooks are live but there is no token", () => {
    expect(
      deriveSetupState({
        hasCredentials: false,
        hooksPathIsOurs: true,
        hookScriptsPresent: true,
      }),
    ).toBe("partial");
  });

  it("treats leftover hook scripts under a foreign hooksPath as not-installed", () => {
    // Scripts on disk but core.hooksPath points elsewhere: nothing fires, and
    // there is no token — this is the fresh-install case, not a repair case.
    expect(
      deriveSetupState({
        hasCredentials: false,
        hooksPathIsOurs: false,
        hookScriptsPresent: true,
      }),
    ).toBe("not-installed");
  });
});

describe("factsFromStatus", () => {
  it("requires all three hook scripts to be present", () => {
    expect(factsFromStatus(status()).hookScriptsPresent).toBe(true);
    expect(
      factsFromStatus(status({ hooks: ["post-commit", "pre-push"] }))
        .hookScriptsPresent,
    ).toBe(false);
  });

  it("reads credential presence, not content", () => {
    expect(factsFromStatus(status({ credentials: null })).hasCredentials).toBe(
      false,
    );
  });

  it("maps a real CLI install to active", () => {
    expect(setupStateFromStatus(status())).toBe("active");
  });
});

describe("partialReason", () => {
  it("names a hijacked hooks path", () => {
    const s = status({ hooksPathIsOurs: false, hooksPath: "/home/dev/.husky" });
    expect(partialReason(s)).toContain("/home/dev/.husky");
  });

  it("names an unset hooks path", () => {
    const s = status({ hooksPathIsOurs: false, hooksPath: null });
    expect(partialReason(s)).toContain("not set to DevPulse");
  });

  it("names missing hook scripts", () => {
    expect(partialReason(status({ hooks: [] }))).toContain("missing");
  });

  it("names a missing token", () => {
    expect(partialReason(status({ credentials: null }))).toContain(
      "no agent token",
    );
  });

  it("is null unless the state is partial", () => {
    expect(partialReason(status())).toBeNull();
    expect(
      partialReason(
        status({ credentials: null, hooksPathIsOurs: false, hooks: [] }),
      ),
    ).toBeNull();
  });
});
