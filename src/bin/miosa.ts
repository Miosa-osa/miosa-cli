#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { MiosaError } from "../errors.js";

// Dynamically read version from package.json so it stays in sync
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("miosa")
  .description(
    "MIOSA CLI — application module infrastructure for the Optimal System. Manage Computers, Sandboxes, and OpenComputers hosts from your shell.",
  )
  .version(pkg.version, "-v, --version")
  .addHelpText(
    "after",
    `
Examples:
  miosa login                                   Authenticate (opens browser)
  miosa computers list                          List all Computers
  miosa computers vnc <id>                      Open a Computer's VNC viewer
  miosa sandbox list                            List all Sandboxes
  miosa sandbox exec <id> --data '{"cmd":"…"}'  Run a command in a Sandbox
  miosa hosts                                   List all OpenComputers hosts
  miosa ssh my-mac                              Interactive terminal on a host
  miosa exec my-mac "npm test"                  Run a command and stream output
  miosa cp ./file.txt my-mac:/tmp/              Upload a file
  miosa tunnel open my-mac --port 3000          Expose a port publicly
  miosa agent my-mac "run the tests"            Dispatch an AI agent task
  miosa deploy                                  Deploy a GitHub repo (60s)
  miosa status                                  Show auth and account info

Documentation: https://miosa.ai/docs/cli/
`,
  );

// Dynamically import and register all command modules
const commandModules = [
  "../commands/auth.js",
  "../commands/login.js",
  "../commands/logout.js",
  "../commands/doctor.js",
  "../commands/hosts.js",
  "../commands/host.js",
  "../commands/computers.js",
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
  "../commands/deploy.js",
  "../commands/apps.js",
  "../commands/logs.js",
  "../commands/releases.js",
  "../commands/secrets.js",
  "../commands/volumes.js",
  "../commands/regions.js",
  "../commands/groups.js",
  "../commands/meshes.js",
  "../commands/schedules.js",
  "../commands/alerts.js",
  "../commands/audit.js",
  "../commands/webhooks.js",
  "../commands/gha-runners.js",
  "../commands/backups.js",
  "../commands/workspaces.js",
  "../commands/services.js",
  "../commands/containers.js",
] as const;

async function main(): Promise<void> {
  // Register all commands
  for (const mod of commandModules) {
    const m = (await import(mod)) as { register: (p: Command) => void };
    m.register(program);
  }

  // Global error handler — catches unhandled MiosaErrors thrown outside command actions
  process.on("uncaughtException", (err) => {
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
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Fatal: ${msg}`));
  process.exit(1);
});
