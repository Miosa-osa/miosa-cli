/**
 * `miosa db` — ergonomic alias for `miosa databases` with extra subcommands:
 *   db connect <id>   open psql with fetched DATABASE_URL
 *   db backup <id>    trigger an on-demand backup
 *   db restore <id>   restore from a backup
 *
 * All other CRUD is delegated to the existing `databases` command tree.
 */
import { spawn } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface DatabaseCredentials {
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
}

interface BackupRecord {
  id: string;
  database_id: string;
  state?: string;
  size_bytes?: number | null;
  created_at?: string;
}

interface RestoreRecord {
  id: string;
  database_id: string;
  backup_id: string;
  state?: string;
  started_at?: string | null;
}

function unwrapCredentials(raw: unknown): DatabaseCredentials {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r["data"] && typeof r["data"] === "object")
      return r["data"] as DatabaseCredentials;
    return r as DatabaseCredentials;
  }
  return {};
}

function buildPsqlUrl(creds: DatabaseCredentials): string | null {
  if (creds.url) return creds.url;
  if (creds.host && creds.database && creds.username) {
    const port = creds.port ?? 5432;
    const pass = creds.password ? `:${creds.password}` : "";
    return `postgres://${creds.username}${pass}@${creds.host}:${port}/${creds.database}`;
  }
  return null;
}

function unwrapBackup(raw: unknown): BackupRecord {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r["data"] && typeof r["data"] === "object")
      return r["data"] as unknown as BackupRecord;
    return raw as unknown as BackupRecord;
  }
  return { id: "", database_id: "" };
}

function unwrapRestore(raw: unknown): RestoreRecord {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r["data"] && typeof r["data"] === "object")
      return r["data"] as unknown as RestoreRecord;
    return raw as unknown as RestoreRecord;
  }
  return { id: "", database_id: "", backup_id: "" };
}

export function register(program: Command): void {
  const db = program
    .command("db")
    .description(
      "Database shortcuts — connect, backup, restore (alias: databases)",
    )
    .addHelpText(
      "after",
      `
Examples:
  miosa db connect <id>                 Open psql with fetched DATABASE_URL
  miosa db connect <id> --print-url     Print the connection URL without opening psql
  miosa db backup <id>                  Trigger an on-demand backup
  miosa db restore <id> --backup <bid>  Restore from a specific backup
`,
    );

  // ── db connect ────────────────────────────────────────────────────────────

  db.command("connect <id>")
    .description(
      "Fetch connection credentials and open psql (requires psql in PATH)",
    )
    .option("--print-url", "Print the connection URL instead of launching psql")
    .option("--json", "Output raw JSON credentials")
    .action(
      async (id: string, opts: { printUrl?: boolean; json?: boolean }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin("Fetching credentials...");

          const creds = unwrapCredentials(
            await client.apiGet(
              `/api/v1/databases/${encodeURIComponent(id)}/credentials`,
            ),
          );
          spinner.stop();

          if (opts.json) {
            console.log(JSON.stringify(creds, null, 2));
            return;
          }

          const url = buildPsqlUrl(creds);
          if (!url) {
            throw new UserError(
              "Could not construct a connection URL from the credentials returned by the API.",
              "Use --json to inspect raw credentials.",
            );
          }

          if (opts.printUrl) {
            console.log(url);
            return;
          }

          // Open psql
          console.log(chalk.dim(`  Connecting to ${id}...`));
          const psql = spawn("psql", [url], { stdio: "inherit" });
          psql.on("error", () => {
            console.error(
              chalk.red("  psql not found. Install PostgreSQL client tools."),
            );
            console.log(`  Connection URL: ${chalk.cyan(url)}`);
            process.exit(1);
          });
          psql.on("close", (code) => {
            process.exit(code ?? 0);
          });
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── db backup ─────────────────────────────────────────────────────────────

  db.command("backup <id>")
    .description("Trigger an on-demand database backup")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Requesting backup...");

        const backup = unwrapBackup(
          await client.apiPost(
            `/api/v1/databases/${encodeURIComponent(id)}/backups`,
            {},
          ),
        );
        spinner.succeed(`Backup requested (id: ${backup.id.slice(0, 12)})`);

        if (opts.json) {
          console.log(JSON.stringify(backup, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("Backup ID")}   ${backup.id}`);
        console.log(
          `  ${chalk.bold("State")}       ${backup.state ?? "creating"}`,
        );
        console.log();
        console.log(
          chalk.dim(
            `  Backup may take a few minutes. Check status with: miosa databases get ${id}`,
          ),
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // ── db restore ────────────────────────────────────────────────────────────

  db.command("restore <id>")
    .description("Restore a database from a backup")
    .requiredOption("--backup <backup-id>", "Backup ID to restore from")
    .option("--json", "Output raw JSON")
    .option("-f, --force", "Skip confirmation prompt")
    .action(
      async (
        id: string,
        opts: { backup: string; json?: boolean; force?: boolean },
      ) => {
        try {
          if (!opts.force) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.yellow(
                  `Restore database ${id} from backup ${opts.backup}? Current data will be overwritten.`,
                ),
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("  Cancelled."));
              process.exit(0);
            }
          }

          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin("Requesting restore...");

          const restore = unwrapRestore(
            await client.apiPost(
              `/api/v1/databases/${encodeURIComponent(id)}/restores`,
              { backup_id: opts.backup },
            ),
          );
          spinner.succeed(`Restore initiated (id: ${restore.id.slice(0, 12)})`);

          if (opts.json) {
            console.log(JSON.stringify(restore, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Restore ID")}   ${restore.id}`);
          console.log(
            `  ${chalk.bold("State")}         ${restore.state ?? "pending"}`,
          );
          console.log();
          console.log(
            chalk.dim(
              "  Restore will complete in the background. Database will be briefly unavailable.",
            ),
          );
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );
}
