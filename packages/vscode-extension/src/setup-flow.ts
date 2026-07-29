import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { runInstall, runUninstall } from "@mnl-dev-telemetry/setup";
import { activateUrl, normalizeDashboardUrl } from "./lib/urls";

/**
 * The "Enable MnlDevTelemetry" and "Uninstall" flows: thin UI around the setup CLI's
 * `runInstall` / `runUninstall` (brief §4 — import, don't shell out). Nothing
 * about device auth, hook installation, or credential storage is reimplemented
 * here; this file only decides what the human sees while that code runs.
 */

/** Where the agent bundle lives inside the packaged extension. */
export function bundledAgentPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "dist", "agent.js");
}

function isCancellation(err: unknown): boolean {
  return err instanceof Error && /cancelled/i.test(err.message);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface EnableResult {
  ok: boolean;
  cancelled: boolean;
}

/**
 * Run the full first-run setup with a cancellable progress notification.
 *
 * The device-auth handshake can sit waiting on a human for minutes, so it runs
 * inside `withProgress` (never on the activation path) and surfaces the user
 * code both in the progress message and in a notification carrying an
 * "Open activation page" button. Cancelling the notification aborts the poll
 * loop via the `signal` the CLI's `deviceLogin` honours.
 */
export async function runEnableFlow(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
  dashboardUrl: string,
): Promise<EnableResult> {
  const baseUrl = normalizeDashboardUrl(dashboardUrl);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "MnlDevTelemetry: setting up this machine",
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      const cancelSub = token.onCancellationRequested(() => controller.abort());

      channel.appendLine(`\n[${new Date().toISOString()}] enable → ${baseUrl}`);
      progress.report({ message: "requesting an activation code…" });

      try {
        await runInstall({
          baseUrl,
          label: os.hostname(),
          agentSourcePath: bundledAgentPath(context),
          signal: controller.signal,
          log: (msg) => {
            if (msg.trim() !== "") channel.appendLine(msg);
          },
          onCode: (start) => {
            const code = start.user_code;
            progress.report({
              message: `enter code ${code} in your browser, then approve`,
            });
            // Not awaited: the poll loop must keep running while this sits open.
            void showActivationPrompt(code, start.verification_uri, baseUrl);
          },
        });
      } catch (err) {
        cancelSub.dispose();
        channel.appendLine(`✗ ${message(err)}`);
        if (isCancellation(err) || token.isCancellationRequested) {
          return { ok: false, cancelled: true };
        }
        void vscode.window
          .showErrorMessage(`MnlDevTelemetry setup failed: ${message(err)}`, "Show log")
          .then((choice) => {
            if (choice === "Show log") channel.show(true);
          });
        return { ok: false, cancelled: false };
      }

      cancelSub.dispose();
      return { ok: true, cancelled: false };
    },
  );
}

/**
 * Show the user code with a button that opens the SSO-gated activation page.
 * The code also goes to the clipboard so approving is paste-and-go.
 */
async function showActivationPrompt(
  userCode: string,
  verificationUri: string,
  baseUrl: string,
): Promise<void> {
  // Prefer the URI the server minted; fall back to the configured dashboard.
  const target = /^https?:\/\//i.test(verificationUri)
    ? verificationUri
    : activateUrl(baseUrl);

  await vscode.env.clipboard.writeText(userCode);
  const choice = await vscode.window.showInformationMessage(
    `MnlDevTelemetry: sign in and enter code ${userCode} to approve this machine. (Copied to your clipboard.)`,
    "Open activation page",
    "Copy code again",
  );
  if (choice === "Open activation page") {
    await vscode.env.openExternal(vscode.Uri.parse(target));
  } else if (choice === "Copy code again") {
    await vscode.env.clipboard.writeText(userCode);
  }
}

/** Confirm, then reverse the install (parity with the CLI's `uninstall`). */
export async function runUninstallFlow(
  channel: vscode.OutputChannel,
): Promise<boolean> {
  const confirm = await vscode.window.showWarningMessage(
    "Remove MnlDevTelemetry from this machine?",
    {
      modal: true,
      detail:
        "Deletes ~/.devpulse (agent, git hooks, spool and agent token) and restores any git hooks path that was set before MnlDevTelemetry. Events already sent are unaffected.",
    },
    "Uninstall",
  );
  if (confirm !== "Uninstall") return false;

  channel.appendLine(`\n[${new Date().toISOString()}] uninstall`);
  try {
    await runUninstall({
      log: (msg) => {
        if (msg.trim() !== "") channel.appendLine(msg);
      },
    });
  } catch (err) {
    channel.appendLine(`✗ ${message(err)}`);
    void vscode.window
      .showErrorMessage(`MnlDevTelemetry uninstall failed: ${message(err)}`, "Show log")
      .then((choice) => {
        if (choice === "Show log") channel.show(true);
      });
    return false;
  }
  void vscode.window.showInformationMessage("MnlDevTelemetry removed from this machine.");
  return true;
}
