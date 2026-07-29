import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundle the extension to a single CJS file (VS Code loads extensions as CJS),
 * and ship the git-hook agent alongside it.
 *
 * `@devpulse/setup` and `@devpulse/shared` are source-only workspace packages,
 * so esbuild inlines them here exactly as tsup does for the CLI — the extension
 * reuses the tested install/status/uninstall logic instead of reimplementing it
 * (docs/phase-6-extension-brief.md §4). `vscode` is provided by the host and
 * must stay external.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/**
 * `runInstall` copies `agent.js` to `~/.devpulse/agent.js`. The CLI reads it
 * from its own dist/; we ship the identical bundle inside the extension and
 * point `agentSourcePath` at it, so a VSIX install writes byte-identical
 * machine state to a CLI install.
 */
function copyAgent() {
  const from = path.join(here, "..", "setup-cli", "dist", "agent.js");
  const to = path.join(here, "dist", "agent.js");
  if (!fs.existsSync(from)) {
    throw new Error(
      `missing ${from} — run \`pnpm --filter @devpulse/setup build\` first ` +
        "(turbo does this automatically via the build dependency)",
    );
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const kb = (fs.statSync(to).size / 1024).toFixed(1);
  console.log(`copied agent.js → dist/agent.js (${kb} KB)`);
}

/** Report bundle failures as a single line in watch mode instead of a stack. */
const problemMatcherPlugin = {
  name: "problem-matcher",
  setup(b) {
    b.onEnd((result) => {
      for (const e of result.errors) {
        const loc = e.location;
        console.error(
          `✘ ${e.text}${loc ? ` (${loc.file}:${loc.line}:${loc.column})` : ""}`,
        );
      }
      if (result.errors.length === 0) console.log("✔ bundled dist/extension.js");
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(here, "src", "extension.ts")],
  outfile: path.join(here, "dist", "extension.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "warning",
  plugins: [problemMatcherPlugin],
};

copyAgent();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(options);
}
