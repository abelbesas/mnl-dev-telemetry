# DevPulse
Client-agnostic dev telemetry. Full spec: docs/devpulse-mvp-brief.md — read it first.

## Rules
- TypeScript strict; zod-validate every external payload; schemas live ONLY in packages/shared.
- Never log or store code contents, diffs, file paths, or prompts — metadata only (spec §2).
- Git hooks must never block a commit: 2s timeout, spool on failure.
- Agent tokens: write-only (+ own-current-day read for get_my_tasks). Jira/Tempo creds server-side only.
- pnpm + turborepo. Tests with vitest; every phase's acceptance checks become tests.
- Verify current docs for external APIs (Tempo v4, Jira Cloud, MCP SDK, Claude Code hooks) rather than assuming.
- Work only on the phase named in the prompt; write docs/phase-N-notes.md when done.