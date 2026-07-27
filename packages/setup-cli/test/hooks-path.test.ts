import { describe, expect, it } from "vitest";
import {
  planHooksPathInstall,
  planHooksPathUninstall,
  resolveChainedHook,
} from "../src/hooks-path";

const OURS = "/home/dev/.devpulse/hooks";

describe("planHooksPathInstall", () => {
  it("stores null and sets our path on a clean machine", () => {
    const plan = planHooksPathInstall(null, OURS);
    expect(plan).toEqual({
      alreadyInstalled: false,
      setHooksPath: true,
      previousToStore: null,
    });
  });

  it("treats empty string like unset", () => {
    const plan = planHooksPathInstall("   ", OURS);
    expect(plan.previousToStore).toBeNull();
    expect(plan.setHooksPath).toBe(true);
  });

  it("captures a pre-existing hooks path to chain (e.g. husky)", () => {
    const plan = planHooksPathInstall("/home/dev/.config/husky", OURS);
    expect(plan.alreadyInstalled).toBe(false);
    expect(plan.setHooksPath).toBe(true);
    expect(plan.previousToStore).toBe("/home/dev/.config/husky");
  });

  it("is idempotent — a re-install does not overwrite the stored previous path", () => {
    const plan = planHooksPathInstall(OURS, OURS);
    expect(plan.alreadyInstalled).toBe(true);
    expect(plan.setHooksPath).toBe(false);
    // previousToStore is undefined → caller must leave the stored value alone,
    // so we never end up chaining to ourselves.
    expect(plan.previousToStore).toBeUndefined();
  });
});

describe("planHooksPathUninstall", () => {
  it("unsets when there was no previous path", () => {
    expect(planHooksPathUninstall(null)).toEqual({ restoreTo: null });
    expect(planHooksPathUninstall("")).toEqual({ restoreTo: null });
  });

  it("restores the previous path when one was stored", () => {
    expect(planHooksPathUninstall("/home/dev/.config/husky")).toEqual({
      restoreTo: "/home/dev/.config/husky",
    });
  });
});

describe("resolveChainedHook", () => {
  const exists = (p: string) =>
    p === "/prev/post-commit" || p === "/prev/pre-push";

  it("returns null when there is no previous path", () => {
    expect(resolveChainedHook(null, "post-commit", exists)).toBeNull();
    expect(resolveChainedHook("  ", "post-commit", exists)).toBeNull();
  });

  it("returns the chained hook path when it exists and is executable", () => {
    expect(resolveChainedHook("/prev", "post-commit", exists)).toBe(
      "/prev/post-commit",
    );
  });

  it("returns null when the previous path has no such hook", () => {
    expect(resolveChainedHook("/prev", "post-checkout", exists)).toBeNull();
  });

  it("normalizes a trailing slash on the previous path", () => {
    expect(resolveChainedHook("/prev/", "pre-push", exists)).toBe(
      "/prev/pre-push",
    );
  });
});
