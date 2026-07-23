import { describe, expect, it } from "vitest";
import {
  extractAllIssueKeys,
  extractIssueKey,
  isIssueKey,
} from "../src/issue-key";

describe("isIssueKey", () => {
  it("accepts canonical keys", () => {
    expect(isIssueKey("ABC-123")).toBe(true);
    expect(isIssueKey("DEV-1")).toBe(true);
    expect(isIssueKey("A1_B2-42")).toBe(true);
  });

  it("rejects non-keys", () => {
    expect(isIssueKey("abc-123")).toBe(false); // lowercase project key
    expect(isIssueKey("A-1")).toBe(false); // needs >= 2 leading chars
    expect(isIssueKey("ABC-")).toBe(false);
    expect(isIssueKey("ABC123")).toBe(false);
    expect(isIssueKey("feature/ABC-123")).toBe(false); // not the whole string
  });
});

describe("extractIssueKey", () => {
  it("extracts from a branch name", () => {
    expect(extractIssueKey("feature/ABC-123-add-widget")).toBe("ABC-123");
    expect(extractIssueKey("ABC-7")).toBe("ABC-7");
  });

  it("prefers the branch over the commit message (spec §3)", () => {
    expect(extractIssueKey("feature/ABC-123", "fixes DEV-999")).toBe("ABC-123");
  });

  it("falls back to the commit message when the branch has no key", () => {
    expect(extractIssueKey("main", "DEV-999 fix the thing")).toBe("DEV-999");
    expect(extractIssueKey(null, "DEV-42: refactor")).toBe("DEV-42");
  });

  it("returns null when neither has a key", () => {
    expect(extractIssueKey("main", "no ticket here")).toBeNull();
    expect(extractIssueKey(undefined, undefined)).toBeNull();
    expect(extractIssueKey("", "")).toBeNull();
  });
});

describe("extractAllIssueKeys", () => {
  it("finds every distinct key in order", () => {
    expect(extractAllIssueKeys("ABC-1 and DEV-2 and ABC-1 again")).toEqual([
      "ABC-1",
      "DEV-2",
    ]);
  });

  it("returns empty for no matches", () => {
    expect(extractAllIssueKeys("nothing")).toEqual([]);
    expect(extractAllIssueKeys(null)).toEqual([]);
  });
});
