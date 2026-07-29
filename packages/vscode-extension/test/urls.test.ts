import { describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_URL,
  activateUrl,
  normalizeDashboardUrl,
  taskUrl,
  timelineUrl,
} from "../src/lib/urls";

describe("normalizeDashboardUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeDashboardUrl("https://dash.example/")).toBe(
      "https://dash.example",
    );
    expect(normalizeDashboardUrl("https://dash.example///")).toBe(
      "https://dash.example",
    );
  });

  it("falls back to the shipped default for blank input", () => {
    expect(normalizeDashboardUrl("")).toBe(DEFAULT_DASHBOARD_URL);
    expect(normalizeDashboardUrl("   ")).toBe(DEFAULT_DASHBOARD_URL);
    expect(normalizeDashboardUrl(undefined)).toBe(DEFAULT_DASHBOARD_URL);
    expect(normalizeDashboardUrl(null)).toBe(DEFAULT_DASHBOARD_URL);
  });

  it("assumes https when the scheme is missing", () => {
    expect(normalizeDashboardUrl("dash.example")).toBe("https://dash.example");
  });

  it("leaves an explicit http scheme alone (local dashboards)", () => {
    expect(normalizeDashboardUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
  });
});

describe("dashboard links", () => {
  it("builds the activation, timeline and task URLs", () => {
    expect(activateUrl("https://dash.example/")).toBe(
      "https://dash.example/activate",
    );
    expect(timelineUrl("https://dash.example")).toBe(
      "https://dash.example/timeline",
    );
    expect(taskUrl("https://dash.example", "TEX-123")).toBe(
      "https://dash.example/tasks/TEX-123",
    );
  });

  it("encodes the issue key into the path", () => {
    expect(taskUrl("https://dash.example", "A B/C-1")).toBe(
      "https://dash.example/tasks/A%20B%2FC-1",
    );
  });
});
