# DevPulse for VS Code

One-click setup for [DevPulse](../../docs/devpulse-mvp-brief.md) and current-task
visibility in the status bar. Works in VS Code and Cursor.

## What it does

- **Enable DevPulse** — installs the machine-global git hooks and completes the
  device-auth login: you approve once in the browser and you're done. No repo is
  ever modified.
- **Status bar** — shows the issue key derived from the current branch
  (`TEX-123-add-widget` → `TEX-123`), click to open that task in the dashboard.
  Hover for the dashboard URL, token label and last event sent.
- **Branch nudge** — if the branch name carries no issue key, the status bar says
  so, because time then groups by repo + branch instead of a ticket.
- **Heartbeats** — a presence ping every 5 minutes *while you're actually
  editing*, so a session starts when you started working rather than at your
  first commit, and keeps counting after your last one. Stops automatically after
  5 minutes without an edit, so an editor left open overnight logs nothing.
- **Commands** (`DevPulse:` in the command palette) — Enable, Show status,
  Open dashboard, Open current task, Uninstall.

## What it does *not* do

- It does not read your code, diffs, file paths or prompts. Events carry
  metadata only (repo basename, branch, issue key, timestamps, diff counts).
  Document edits are used only to stamp a clock — never the file name or contents.
- The only thing it sends on its own is a heartbeat: repo basename, branch and a
  timestamp. Commits, pushes and branch switches come from the machine-global git
  hooks, which keep working even if this extension is disabled.
- It never holds Jira or Tempo credentials. Only the server does.

The agent token lives in `~/.devpulse/credentials` (mode 0600), written by the
same setup code the `devpulse-setup` CLI uses.

## Settings

| Setting | Default |
|---|---|
| `devpulse.dashboardUrl` | `https://mnl-dev-telemetry-dashboard.vercel.app` |

## Install from a VSIX

```bash
code --install-extension devpulse-vscode.vsix
```

Or: Extensions panel → `…` → **Install from VSIX…**. Cursor: same panel.

## Develop

```bash
pnpm --filter devpulse-vscode build     # dist/extension.js + dist/agent.js
pnpm --filter devpulse-vscode watch     # rebuild on change
pnpm --filter devpulse-vscode test      # vitest (pure logic)
pnpm --filter devpulse-vscode package   # → devpulse-vscode.vsix
```

Open **this folder** (not the monorepo root) and press <kbd>F5</kbd> to launch an
Extension Development Host. `.vscode/launch.json` already points `DEVPULSE_HOME`
and `GIT_CONFIG_GLOBAL` at `.devpulse-dev/` inside this package, so enabling
DevPulse in the dev host never touches your real install or global git config.
Set `devpulse.dashboardUrl` to `http://localhost:3000` to test against a local
dashboard.
