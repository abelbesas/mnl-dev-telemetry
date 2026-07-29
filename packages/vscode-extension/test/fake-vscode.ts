/**
 * A stub of the `vscode` module — just enough of it to load the real bundled
 * extension in-process and drive `activate()`. Lets us assert the things that
 * only show up when the whole wiring runs (activation latency, what the status
 * bar actually ends up saying, which notifications appear) without downloading
 * an Electron test host.
 */

export interface FakeStatusBarItem {
  id: string;
  name?: string;
  text: string;
  tooltip?: { value: string };
  command?: string;
  backgroundColor?: { id: string };
  accessibilityInformation?: { label: string };
  shown: boolean;
  disposed: boolean;
}

export interface ShownMessage {
  kind: "info" | "warning" | "error";
  message: string;
  items: string[];
}

export interface FakeVscode {
  // --- test handles ---
  __statusBar: FakeStatusBarItem[];
  __commands: Map<string, (...args: unknown[]) => unknown>;
  __messages: ShownMessage[];
  __output: string[];
  __opened: string[];
  /** Answer the next showXMessage with this item (then falls back to undefined). */
  __answer: (message: RegExp, item: string | undefined) => void;

  // --- surface used by the extension ---
  window: Record<string, unknown>;
  workspace: Record<string, unknown>;
  commands: Record<string, unknown>;
  extensions: Record<string, unknown>;
  env: Record<string, unknown>;
  Uri: Record<string, unknown>;
  EventEmitter: unknown;
  MarkdownString: unknown;
  ThemeColor: unknown;
  StatusBarAlignment: Record<string, number>;
  ProgressLocation: Record<string, number>;
}

interface Disposable {
  dispose(): void;
}

const noopDisposable: Disposable = { dispose() {} };

export function createFakeVscode(
  config: Record<string, unknown> = {},
): FakeVscode {
  const statusBar: FakeStatusBarItem[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const messages: ShownMessage[] = [];
  const output: string[] = [];
  const opened: string[] = [];
  const answers: Array<[RegExp, string | undefined]> = [];

  class FakeEventEmitter<T> {
    private readonly listeners = new Set<(e: T) => unknown>();
    readonly event = (listener: (e: T) => unknown): Disposable => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(e: T): void {
      for (const l of [...this.listeners]) l(e);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class FakeMarkdownString {
    supportThemeIcons = false;
    constructor(public value = "") {}
  }

  class FakeThemeColor {
    constructor(public readonly id: string) {}
  }

  function record(
    kind: ShownMessage["kind"],
    message: string,
    rest: unknown[],
  ): Promise<string | undefined> {
    // Modal messages pass an options object before the action items.
    const items = rest
      .filter((r) => typeof r === "string")
      .map((r) => r as string);
    messages.push({ kind, message, items });
    const hit = answers.findIndex(([pattern]) => pattern.test(message));
    if (hit !== -1) {
      const [, item] = answers.splice(hit, 1)[0]!;
      return Promise.resolve(item);
    }
    return Promise.resolve(undefined);
  }

  return {
    __statusBar: statusBar,
    __commands: commands,
    __messages: messages,
    __output: output,
    __opened: opened,
    __answer: (message, item) => answers.push([message, item]),

    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    EventEmitter: FakeEventEmitter,
    MarkdownString: FakeMarkdownString,
    ThemeColor: FakeThemeColor,

    window: {
      state: { focused: true },
      activeTextEditor: undefined,
      createStatusBarItem(id: string) {
        const item: FakeStatusBarItem = {
          id,
          text: "",
          shown: false,
          disposed: false,
          show() {
            item.shown = true;
          },
          dispose() {
            item.disposed = true;
          },
        } as unknown as FakeStatusBarItem;
        statusBar.push(item);
        return item;
      },
      createOutputChannel() {
        return {
          appendLine: (line: string) => output.push(line),
          show: () => {},
          dispose: () => {},
        };
      },
      showInformationMessage: (m: string, ...rest: unknown[]) =>
        record("info", m, rest),
      showWarningMessage: (m: string, ...rest: unknown[]) =>
        record("warning", m, rest),
      showErrorMessage: (m: string, ...rest: unknown[]) =>
        record("error", m, rest),
      withProgress: (
        _opts: unknown,
        task: (
          progress: { report: (v: unknown) => void },
          token: { isCancellationRequested: boolean; onCancellationRequested: () => Disposable },
        ) => unknown,
      ) =>
        task(
          { report: () => {} },
          {
            isCancellationRequested: false,
            onCancellationRequested: () => noopDisposable,
          },
        ),
      onDidChangeActiveTextEditor: () => noopDisposable,
      onDidChangeWindowState: () => noopDisposable,
    },

    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: (key: string) => config[key],
      }),
      onDidChangeConfiguration: () => noopDisposable,
      onDidChangeWorkspaceFolders: () => noopDisposable,
    },

    commands: {
      registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
        commands.set(id, fn);
        return { dispose: () => commands.delete(id) };
      },
    },

    // No git extension → the extension falls back to the `git rev-parse` path.
    extensions: { getExtension: () => undefined },

    env: {
      openExternal: (uri: { toString(): string }) => {
        opened.push(uri.toString());
        return Promise.resolve(true);
      },
      clipboard: { writeText: () => Promise.resolve() },
    },

    Uri: {
      parse: (value: string) => ({ toString: () => value, scheme: "https" }),
      file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p, scheme: "file" }),
    },
  };
}
