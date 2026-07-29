import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `src/lib/**` holds every decision worth testing (setup state, status-bar
 * content, URL building). It stays free of `vscode` so vitest can exercise it
 * with no extension host — this test guards that boundary, because a single
 * stray import would silently move logic out of test coverage.
 */

const libDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
);

function libFiles(): string[] {
  return fs
    .readdirSync(libDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(libDir, f));
}

describe("src/lib is editor-free", () => {
  it("has files to check", () => {
    expect(libFiles().length).toBeGreaterThan(0);
  });

  it("never imports vscode", () => {
    const offenders = libFiles().filter((file) =>
      /(from\s+["']vscode["']|require\(\s*["']vscode["']\s*\))/.test(
        fs.readFileSync(file, "utf8"),
      ),
    );
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});
