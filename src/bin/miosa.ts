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
const primaryCommands = new Set([
  "login",
  "up",
  "computers",
  "sandbox",
  "deploy",
  "app",
  "forge",
  "opencomputers",
  "ssh",
  "exec",
  "status",
  "doctor",
  "commands",
  "update",
]);

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

program.configureHelp({
  visibleCommands(command) {
    const visible = [...command.commands];
    if (command.parent) return visible;
    return visible.filter(
      (child) =>
        primaryCommands.has(child.name()) ||
        child.aliases().some((alias) => primaryCommands.has(alias)),
    );
  },
});

program
  .name("miosa")
  .description("Create and control cloud computers, sandboxes, and apps")
  .version(pkg.version, "-v, --version", "Print version number and exit")
  .option(
    "--json",
    "Prefer JSON output for commands that support structured output",
  )
  .option("--debug", "Show request IDs and backend error details")
  .option("--quiet", "Suppress non-essential human-readable output")
  .option("--no-color", "Disable ANSI color output")
  .option("--tenant <tenant>", "Scope API requests to a tenant slug or ID")
  .option(
    "--organization <organization>",
    "Scope API requests to one organization slug or ID",
  )
  .option("--workspace <workspace>", "Scope API requests to a workspace ID")
  .addHelpText(
    "after",
    `
Start here:
  miosa                              Open the interactive menu
  miosa login                        Sign in
  miosa computers create             Create a computer with guided setup
  miosa computers open               Pick and open a desktop
  miosa up                           Deploy the project in this folder

Learn more:
  miosa <command> --help             Help for one command
  miosa commands                     Complete command catalog
  miosa doctor                       Diagnose setup and connectivity
  https://miosa.ai/docs/cli/
`,
  );

program.hook("preAction", (rootCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals<{
    json?: boolean;
    debug?: boolean;
    quiet?: boolean;
    noColor?: boolean;
    tenant?: string;
    organization?: string;
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
  if (opts.organization && opts.tenant && opts.organization !== opts.tenant) {
    throw new Error(
      "--organization and --tenant cannot identify different organizations.",
    );
  }
  if (opts.organization) process.env["MIOSA_ORGANIZATION"] = opts.organization;
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
  "../commands/context.js",
  "../commands/doctor.js",
  "../commands/capabilities.js",
  "../commands/actions.js",
  "../commands/devices.js",
  "../commands/app.js",
  "../commands/operating-contract.js",
  "../commands/command-overview.js",
  "../commands/opencomputers.js",
  "../commands/hosts.js",
  "../commands/host.js",
  "../commands/computers.js",
  "../commands/snapshot.js",
  "../commands/sandbox.js",
  "../commands/run-groups.js",
  "../commands/runs.js",
  "../commands/agent-runtime-profiles.js",
  "../commands/runtime-env.js",
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
  "../commands/connectors.js",
  "../commands/apps.js",
  "../commands/logs.js",
  "../commands/releases.js",
  "../commands/forge.js",
  "../commands/secrets.js",
  "../commands/volumes.js",
  "../commands/regions.js",
  "../commands/cloud.js",
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
