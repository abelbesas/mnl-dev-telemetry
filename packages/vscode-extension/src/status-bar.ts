import * as vscode from "vscode";
import type { StatusPresentation } from "./lib/presentation";

/**
 * Thin adapter: takes the pure `StatusPresentation` and pushes it onto a
 * StatusBarItem. All the rules about *what* to show live in
 * `lib/presentation.ts` so they can be tested without an extension host.
 */
export class MnlDevTelemetryStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "mnlDevTelemetry.status",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "MnlDevTelemetry";
    this.item.show();
  }

  apply(p: StatusPresentation): void {
    this.item.text = p.text;
    this.item.accessibilityInformation = { label: p.ariaLabel };
    const tooltip = new vscode.MarkdownString(p.tooltip);
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
    this.item.command = p.command;
    this.item.backgroundColor = p.warning
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
