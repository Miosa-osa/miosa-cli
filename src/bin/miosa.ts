#!/usr/bin/env node
import "../cli-env.js";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { MiosaError } from "../errors.js";
import { scheduleUpdateCheck } from "../update-check.js";
import { isJsonMode, isQuietMode } from "../cli-env.js";

// Dynamically read version from package.json so it stays in sync
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

const program = new Command();

program.configureOutput({
  writeErr: (str) => {
    if (!isJsonMode()) process.stderr.write(str);
  },
  outputError: (str, write) => {
    if (!isJsonMode()) write(str);
  },
});

program.exitOverride((err) => {
  if (err.exitCode === 0) {
    process.exit(0);
  }
  if (isJsonMode()) {
    const message = err.message.replace(/^error:\s*/i, "");
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: "CLI_USAGE_ERROR",
            message,
            retryable: false,
          },
        },
        null,
        2,
      ),
    );
    process.exit(err.exitCode || 1);
  }
  throw err;
});

program
  .name("miosa")
  .description(
    "MIOSA CLI — application module infrastructure for the Optimal System. Manage Computers, Sandboxes, and OpenComputers hosts from your shell.",
  )
  .version(pkg.version, "-v, --version", "Print version number and exit")
  .option(
    "--json",
    "Prefer JSON output for commands that support structured output",
  )
  .option("--debug", "Show request IDs and backend error details")
  .option("--quiet", "Suppress non-essential human-readable output")
  .option("--no-color", "Disable ANSI color output")
  .option("--tenant <tenant>", "Scope API requests to a tenant slug or ID")
  .option("--workspace <workspace>", "Scope API requests to a workspace ID")
  .addHelpText(
    "after",
    `
Examples:
  miosa login                                   Authenticate (opens browser)
  miosa login --api-key msk_u_...               Authenticate with an API key
  miosa login --stdin                           Pipe an API key: echo 'msk_...' | miosa login --stdin
  miosa whoami                                  Verify and show current auth state
  miosa whoami --cached                         Show stale local identity without an API call
  miosa config ls                               List all config keys
  miosa config set region us-nyc                Set a config value
  miosa doctor                                  Diagnose CLI, auth, and toolchain
  miosa capabilities --json                    Print agent-readable workflows and command recipes
  miosa computers list                          List all Computers
  miosa computers vnc <id>                      Open a Computer's VNC viewer
  miosa sandbox list                            List all Sandboxes
  miosa sandbox exec <id> --data '{"cmd":"…"}'  Run a command in a Sandbox
  miosa hosts                                   List all OpenComputers hosts
  miosa ssh my-mac                              Interactive terminal on a Computer or host
  miosa exec my-mac "npm test"                  Run a command and stream output
  miosa cp ./file.txt my-mac:/tmp/              Upload a file
  miosa tunnel open my-mac --port 3000          Expose a port publicly
  miosa agent my-mac "run the tests"            Dispatch an AI agent task
  miosa completion zsh > ~/.zsh/completions/_miosa
  miosa watch my-dev-box                        Stream real-time events from a Computer
  miosa watch my-dev-box --filter exec,desktop  Watch only exec and desktop events
  miosa watch my-dev-box --json                 Machine-readable event stream (one JSON/line)
  miosa up                                      Smart launch (auto-detects context)
  miosa up --computer --os ubuntu               Create a desktop computer
  miosa up --sandbox --image python-3.12        Create a sandbox
  miosa deploy                                  Deploy a GitHub repo (60s)
  miosa update                                  Update @miosa/cli to latest
  miosa status                                  Show auth and account info

Documentation: https://miosa.ai/docs/cli/

Environment:
  MIOSA_JSON=1       Prefer JSON output where supported
  MIOSA_NO_COLOR=1   Disable ANSI color output
  MIOSA_DEBUG=1      Show request IDs and backend error details
  MIOSA_QUIET=1      Suppress non-essential human-readable output
  MIOSA_TENANT=...   Default tenant slug or ID request scope
  MIOSA_WORKSPACE=... Default workspace ID request scope
`,
  );

program.hook("preAction", (rootCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals<{
    json?: boolean;
    debug?: boolean;
    quiet?: boolean;
    noColor?: boolean;
    tenant?: string;
    workspace?: string;
  }>();
  if (rootCommand.opts<{ json?: boolean }>().json || opts.json) {
    process.env["MIOSA_JSON"] = "1";
  }
  if (opts.debug) process.env["MIOSA_DEBUG"] = "1";
  if (opts.quiet) process.env["MIOSA_QUIET"] = "1";
  if (opts.noColor) {
    process.env["MIOSA_NO_COLOR"] = "1";
    process.env["NO_COLOR"] = process.env["NO_COLOR"] || "1";
    process.env["FORCE_COLOR"] = "0";
  }
  if (opts.tenant) process.env["MIOSA_TENANT"] = opts.tenant;
  if (opts.workspace) process.env["MIOSA_WORKSPACE"] = opts.workspace;
});

// `miosa version` — explicit subcommand (mirrors `miosa --version`)
program
  .command("version")
  .description("Print the current @miosa/cli version")
  .action(() => {
    console.log(pkg.version);
  });

// Dynamically import and register all command modules
const commandModules = [
  "../commands/auth.js",
  "../commands/login.js",
  "../commands/logout.js",
  "../commands/whoami.js",
  "../commands/config.js",
  "../commands/doctor.js",
  "../commands/capabilities.js",
  "../commands/hosts.js",
  "../commands/host.js",
  "../commands/computers.js",
  "../commands/snapshot.js",
  "../commands/sandbox.js",
  "../commands/connect.js",
  "../commands/ssh.js",
  "../commands/exec.js",
  "../commands/cp.js",
  "../commands/ls.js",
  "../commands/rm.js",
  "../commands/tunnel.js",
  "../commands/agent.js",
  "../commands/watch.js",
  "../commands/status.js",
  "../commands/new.js",
  "../commands/up.js",
  "../commands/update.js",
  "../commands/deploy.js",
  "../commands/docker-deploy.js",
  "../commands/apps.js",
  "../commands/logs.js",
  "../commands/releases.js",
  "../commands/secrets.js",
  "../commands/volumes.js",
  "../commands/regions.js",
  "../commands/groups.js",
  "../commands/meshes.js",
  "../commands/network-policy.js",
  "../commands/schedules.js",
  "../commands/alerts.js",
  "../commands/audit.js",
  "../commands/webhooks.js",
  "../commands/gha-runners.js",
  "../commands/backups.js",
  "../commands/checkpoints.js",
  "../commands/cleanup.js",
  "../commands/workspaces.js",
  "../commands/services.js",
  "../commands/containers.js",
  "../commands/functions.js",
  "../commands/cron.js",
  "../commands/shell.js",
  "../commands/mcp.js",
  "../commands/link.js",
  "../commands/pull.js",
  "../commands/dev.js",
  "../commands/run.js",
  "../commands/tenant.js",
  "../commands/db.js",
  "../commands/env.js",
  "../commands/scale.js",
  "../commands/rollback.js",
  "../commands/builds.js",
  "../commands/storage.js",
  "../commands/databases.js",
  "../commands/domains.js",
  "../commands/teams.js",
  "../commands/billing.js",
  "../commands/templates.js",
  "../commands/dashboard.js",
  "../commands/completion.js",
  // Keep last — registers the default `program.action()` that fires only
  // when no other subcommand matched. Registering earlier would risk it
  // intercepting commands that haven't been wired up yet.
  "../commands/menu.js",
] as const;

async function main(): Promise<void> {
  // Register all commands
  for (const mod of commandModules) {
    const m = (await import(mod)) as { register: (p: Command) => void };
    m.register(program);
  }

  // Global error handler — catches unhandled MiosaErrors thrown outside command actions
  process.on("uncaughtException", (err) => {
    if (isJsonMode()) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: err instanceof MiosaError ? "MIOSA_ERROR" : "FATAL",
              message: err.message,
              retryable: err instanceof MiosaError ? err.exitCode >= 70 : false,
            },
          },
          null,
          2,
        ),
      );
      process.exit(err instanceof MiosaError ? err.exitCode : 1);
    }
    if (err instanceof MiosaError) {
      console.error(chalk.red(`Error: ${err.message}`));
      if (err.hint) console.error(chalk.dim(`  Hint: ${err.hint}`));
      process.exit(err.exitCode);
    }
    console.error(chalk.red(`Fatal: ${err.message}`));
    if (process.env["MIOSA_DEBUG"]) console.error(err.stack);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (isJsonMode()) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: reason instanceof MiosaError ? "MIOSA_ERROR" : "FATAL",
              message,
              retryable:
                reason instanceof MiosaError ? reason.exitCode >= 70 : false,
            },
          },
          null,
          2,
        ),
      );
      process.exit(reason instanceof MiosaError ? reason.exitCode : 1);
    }
    if (reason instanceof MiosaError) {
      console.error(chalk.red(`Error: ${reason.message}`));
      if (reason.hint) console.error(chalk.dim(`  Hint: ${reason.hint}`));
      process.exit(reason.exitCode);
    }
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(chalk.red(`Fatal: ${msg}`));
    if (process.env["MIOSA_DEBUG"] && reason instanceof Error)
      console.error(reason.stack);
    process.exit(1);
  });

  await program.parseAsync(process.argv);

  // Schedule async update check — never blocks, prints notice after command output
  if (!isJsonMode() && !isQuietMode()) {
    scheduleUpdateCheck(pkg.version);
  }
}

main().catch((err: unknown) => {
  if (isJsonMode()) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: { code: "FATAL", message: msg, retryable: false },
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${msg}`));
  process.exit(1);
});
