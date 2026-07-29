import { defineConfig } from "tsup";

/**
 * Two bundled CJS entrypoints, both self-contained so they run on a dev's
 * machine with no node_modules:
 *
 *  - cli.js   — `npx @mnl-dev-telemetry/setup` (install / login / status / uninstall)
 *  - agent.js — copied to ~/.devpulse/agent.js; invoked by the git hooks
 *
 * `@mnl-dev-telemetry/shared` (and its zod dependency) are inlined so the agent can
 * build events with the canonical schemas without a package install
 * (spec: "Events built via the zod schemas ... from packages/shared").
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", agent: "src/agent.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node20",
  clean: true,
  noExternal: [/@mnl-dev-telemetry\/shared/, "zod"],
  banner: { js: "#!/usr/bin/env node" },
});
