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
  recommended_url?: string;
  proxy_url?: string;
  internal_url?: string;
  url?: string;
  uri?: string;
  database_url?: string;
  connection_url?: string;
  connection_string?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  dbname?: string;
  name?: string;
  username?: string;
  user?: string;
  password?: string;
}

interface DatabaseRecord {
  id: string;
  name?: string;
  engine?: string;
  engine_version?: string;
  state?: string;
  region?: string;
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
  const direct =
    creds.recommended_url ??
    creds.proxy_url ??
    creds.url ??
    creds.database_url ??
    creds.connection_url ??
    creds.connection_string ??
    creds.connectionString ??
    creds.uri;
  if (direct) return normalizePostgresUrl(direct);

  const database = creds.database ?? creds.dbname ?? creds.name;
  const username = creds.username ?? creds.user;
  if (creds.host && database && username) {
    const port = creds.port ?? 5432;
    const pass = creds.password ? `:${encodeURIComponent(creds.password)}` : "";
    return `postgresql://${encodeURIComponent(username)}${pass}@${creds.host}:${port}/${database}`;
  }
  return null;
}

function normalizePostgresUrl(url: string): string {
  return url.startsWith("postgres://")
    ? `postgresql://${url.slice("postgres://".length)}`
    : url;
}

function unwrapDatabase(raw: unknown): DatabaseRecord {
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (r["data"] && typeof r["data"] === "object")
      return r["data"] as unknown as DatabaseRecord;
    if (r["database"] && typeof r["database"] === "object")
      return r["database"] as unknown as DatabaseRecord;
    return raw as unknown as DatabaseRecord;
  }
  return { id: "" };
}

function normalizeEngine(engine: string): string {
  const normalized = engine.trim().toLowerCase();
  return normalized === "postgres" ? "postgresql" : normalized;
}

function defaultEngineVersion(engine: string, version?: string): string | undefined {
  if (version) return version;
  return normalizeEngine(engine) === "postgresql" ? "15" : undefined;
}

async function waitForDatabase(
  client: MiosaClient,
  id: string,
  timeoutSec: number,
): Promise<DatabaseRecord> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: DatabaseRecord = { id };
  while (Date.now() < deadline) {
    last = unwrapDatabase(
      await client.apiGet(`/api/v1/databases/${encodeURIComponent(id)}`),
    );
    const state = String(last.state ?? "").toLowerCase();
    if (state === "running" || state === "available") return last;
    if (state === "error" || state === "failed") {
      throw new UserError(`Database ${id} entered ${state} state.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new UserError(
    `Database ${id} did not become available within ${timeoutSec}s.`,
    `Last state: ${last.state ?? "unknown"}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseIntegerOption(value: string): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n)) throw new UserError(`Invalid integer: ${value}`);
  return n;
}

function posixDirname(value: string): string {
  const idx = value.lastIndexOf("/");
  if (idx <= 0) return "/";
  return value.slice(0, idx);
}

function escapeBasicRegex(value: string): string {
  return value.replace(/[.[\*^$()+?{|\\]/g, "\\$&");
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
  miosa db create postgres --name clinic-db --wait
  miosa db connect <id>                 Open psql with fetched DATABASE_URL
  miosa db connect <id> --print-url     Print the connection URL without opening psql
  miosa db attach <id> --sandbox <sid>  Write DATABASE_URL into /workspace/.env
  miosa db backup <id>                  Trigger an on-demand backup
  miosa db restore <id> --backup <bid>  Restore from a specific backup
`,
    );

  // ── db create ─────────────────────────────────────────────────────────────

  db.command("create [engine]")
    .description("Create a managed database")
    .requiredOption("--name <name>", "Database name")
    .option("--engine-version <version>", "Engine version")
    .option("--db-version <version>", "Alias for --engine-version")
    .option("--region <region>", "Region ID")
    .option("--wait", "Wait until the database is running/available")
    .option("--timeout <sec>", "Wait timeout in seconds", parseIntegerOption, 180)
    .option("--json", "Output raw JSON")
    .action(
      async (
        engineArg = "postgresql",
        opts: {
          name: string;
          engineVersion?: string;
          dbVersion?: string;
          region?: string;
          wait?: boolean;
          timeout: number;
          json?: boolean;
        },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const engine = normalizeEngine(engineArg);
          const engineVersion = defaultEngineVersion(
            engine,
            opts.engineVersion ?? opts.dbVersion,
          );
          const body: Record<string, unknown> = {
            name: opts.name,
            engine,
          };
          if (engineVersion) body["engine_version"] = engineVersion;
          if (opts.region) body["region"] = opts.region;

          const spinner = opts.json ? null : spin(`Creating database ${opts.name}...`);
          let db = unwrapDatabase(await client.apiPost("/api/v1/databases", body));
          spinner?.succeed(`Created database ${db.name ?? db.id}`);

          if (opts.wait) {
            db = await waitForDatabase(client, db.id, opts.timeout);
          }

          if (opts.json) {
            console.log(JSON.stringify(db, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}      ${db.id}`);
          console.log(`  ${chalk.bold("Name")}    ${db.name ?? opts.name}`);
          console.log(
            `  ${chalk.bold("Engine")}  ${[db.engine ?? engine, db.engine_version ?? engineVersion].filter(Boolean).join(" ")}`,
          );
          console.log(`  ${chalk.bold("State")}   ${db.state ?? "creating"}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
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
          const spinner = opts.json || opts.printUrl ? null : spin("Fetching credentials...");

          const creds = unwrapCredentials(
            await client.apiGet(
              `/api/v1/databases/${encodeURIComponent(id)}/credentials`,
            ),
          );
          spinner?.stop();

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

  // ── db attach ─────────────────────────────────────────────────────────────

  db.command("attach <id>")
    .description("Attach database credentials to a sandbox or deployment app")
    .option("--sandbox <sandbox-id>", "Sandbox ID")
    .option("--app <deployment-id>", "Deployment app ID")
    .option("--env <name>", "Environment variable name", "DATABASE_URL")
    .option("--path <path>", "Env file path inside the sandbox", "/workspace/.env")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        opts: {
          sandbox?: string;
          app?: string;
          env: string;
          path: string;
          json?: boolean;
        },
      ) => {
        try {
          if (!opts.sandbox && !opts.app) {
            throw new UserError(
              "Choose where to attach the database.",
              "Use --sandbox <sandbox-id> or --app <deployment-id>.",
            );
          }
          if (opts.sandbox && opts.app) {
            throw new UserError(
              "Choose only one attach target.",
              "Use either --sandbox or --app, not both.",
            );
          }

          const config = loadConfig();
          const client = new MiosaClient(config);

          if (opts.app) {
            const result = await client.apiPost(
              `/api/v1/deployments/${encodeURIComponent(opts.app)}/database`,
              { database_id: id, env: opts.env },
            );

            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    database_id: id,
                    app_id: opts.app,
                    env: opts.env,
                    attached: true,
                    result,
                  },
                  null,
                  2,
                ),
              );
              return;
            }

            console.log(chalk.green(`Attached ${opts.env} to app ${opts.app}`));
            return;
          }

          const creds = unwrapCredentials(
            await client.apiGet(
              `/api/v1/databases/${encodeURIComponent(id)}/credentials`,
            ),
          );
          const url = buildPsqlUrl(creds);
          if (!url) {
            throw new UserError(
              "Could not construct a DATABASE_URL from the credentials returned by the API.",
              "Run `miosa db connect <id> --json` to inspect raw credentials.",
            );
          }

          const sandbox = opts.sandbox;
          if (!sandbox) {
            throw new UserError("Sandbox ID is required.");
          }

          const command = [
            `mkdir -p ${shellQuote(posixDirname(opts.path))}`,
            `touch ${shellQuote(opts.path)}`,
            `grep -v '^${escapeBasicRegex(opts.env)}=' ${shellQuote(opts.path)} > ${shellQuote(`${opts.path}.tmp`)} || true`,
            `printf '%s\\n' ${shellQuote(`${opts.env}=${url}`)} >> ${shellQuote(`${opts.path}.tmp`)}`,
            `mv ${shellQuote(`${opts.path}.tmp`)} ${shellQuote(opts.path)}`,
          ].join(" && ");

          const result = await client.apiPost(
            `/api/v1/sandboxes/${encodeURIComponent(sandbox)}/exec`,
            {
              command,
              cwd: "/",
              dir: "/",
              timeout: 15,
            },
          );

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  database_id: id,
                  sandbox_id: sandbox,
                  env: opts.env,
                  path: opts.path,
                  attached: true,
                  exec: result,
                },
                null,
                2,
              ),
            );
            return;
          }

          console.log(
            chalk.green(
              `Attached ${opts.env} to sandbox ${sandbox} at ${opts.path}`,
            ),
          );
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
