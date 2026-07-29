import { writeCredentials } from "./credentials";
import { deviceLogin } from "./device-auth";
import { runInstall, runStatus, runUninstall } from "./install";
import { mnlDevTelemetryPaths } from "./paths";

/**
 * `@mnl-dev-telemetry/setup` CLI (spec §4.3). Commands:
 *   install [--url U] [--login] [--label L]   set up token + git hooks (default)
 *   login   [--url U] [--label L]             (re)run the device-auth login only
 *   status                                    show what's installed
 *   uninstall  (or --uninstall)               fully reverse the install
 */

interface Args {
  command: string;
  url?: string;
  label?: string;
  login: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let url: string | undefined;
  let label: string | undefined;
  let login = false;
  let uninstall = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") url = argv[++i];
    else if (a === "--label") label = argv[++i];
    else if (a === "--login") login = true;
    else if (a === "--uninstall") uninstall = true;
    else if (!a.startsWith("-")) positional.push(a);
  }

  const command = uninstall ? "uninstall" : (positional[0] ?? "install");
  return { command, url, label, login };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "install":
      await runInstall({ baseUrl: args.url, login: args.login, label: args.label });
      break;

    case "login": {
      const baseUrl =
        args.url ?? process.env.MNL_DEV_TELEMETRY_URL ?? "http://localhost:3000";
      const creds = await deviceLogin({ baseUrl, label: args.label });
      const paths = mnlDevTelemetryPaths();
      writeCredentials(paths.credentials, creds);
      console.log("✓ Saved credentials to", paths.credentials, "(mode 0600)");
      break;
    }

    case "status":
      runStatus();
      break;

    case "uninstall":
      await runUninstall();
      break;

    default:
      console.error(`Unknown command: ${args.command}`);
      console.error(
        "Usage: mnl-dev-telemetry-setup [install|login|status|uninstall]",
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
