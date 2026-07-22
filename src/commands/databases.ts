import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { formatBytes } from "../ui/progress.js";
import { formatDuration } from "../ui/render.js";
import { handleError, isJsonMode } from "./util.js";
import { CLI_USER_AGENT } from "../version.js";

interface Database {
  id: string;
  name?: string;
  engine?: string;
  engine_version?: string;
  state?: string;
  region?: string;
  environment_id?: string;
  created_at?: string;
  updated_at?: string;
  connection_test?: {
    status?: string;
    host?: string;
    port?: number;
    reason?: string;
  } | null;
}

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

function unwrapDatabases(
  raw: { data?: Database[]; databases?: Database[] } | Database[],
): Database[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.databases ?? [];
}

function unwrapDatabase(
  raw: { data?: Database; database?: Database } | Database,
): Database {
  if ("data" in raw && raw.data) return raw.data;
  if ("database" in raw && raw.database) return raw.database;
  return raw as Database;
}

function unwrapCredentials(
  raw: { data?: DatabaseCredentials } | DatabaseCredentials,
): DatabaseCredentials {
  if ("data" in raw && raw.data) return raw.data;
  return raw as DatabaseCredentials;
}

function fmtState(db: Database): string {
  const state = db.state ?? "unknown";
  if (state === "running" || state === "available") return chalk.green(state);
  if (state === "creating" || state === "starting" || state === "restarting")
    return chalk.yellow(state);
  if (state === "stopped" || state === "stopping") return chalk.dim(state);
  if (state === "error" || state === "failed") return chalk.red(state);
  return state;
}

function parseIntegerOption(value: string): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n)) throw new UserError(`Invalid integer: ${value}`);
  return n;
}

function isDatabaseReady(db: Database): boolean {
  const state = String(db.state ?? "").toLowerCase();
  if (state !== "running" && state !== "available") return false;
  const connectionStatus = db.connection_test?.status;
  return connectionStatus === undefined || connectionStatus === "ok";
}

async function waitForDatabaseReady(
  client: MiosaClient,
  id: string,
  timeoutSec: number,
): Promise<Database> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: Database = { id };

  while (Date.now() < deadline) {
    last = unwrapDatabase(
      await client.apiGet(`/api/v1/databases/${encodeURIComponent(id)}`),
    );
    const state = String(last.state ?? "").toLowerCase();

    if (isDatabaseReady(last)) return last;

    if (state === "error" || state === "failed") {
      const reason = last.connection_test?.reason;
      throw new UserError(
        `Database ${id} entered ${state} state.`,
        reason ? `Connection test: ${reason}` : undefined,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new UserError(
    `Database ${id} did not become ready within ${timeoutSec}s.`,
    `Last state: ${last.state ?? "unknown"}`,
  );
}

interface LogEntry {
  t?: string | null;
  stream?: string;
  line?: string;
  message?: string;
}

function unwrapLogs(raw: unknown): { database_id?: string; logs: LogEntry[] } {
  const root =
    raw && typeof raw === "object" && "data" in raw
      ? (raw as Record<string, unknown>)["data"]
      : raw;

  if (root && typeof root === "object") {
    const r = root as Record<string, unknown>;
    const logs = Array.isArray(r["logs"]) ? (r["logs"] as LogEntry[]) : [];
    return {
      database_id:
        typeof r["database_id"] === "string" ? r["database_id"] : undefined,
      logs,
    };
  }

  return { logs: [] };
}

function formatLogEntry(entry: LogEntry): string {
  const message = entry.line ?? entry.message ?? "";
  if (entry.t) return `${entry.t} ${message}`;
  return message;
}

function lifecycleVerb(action: "start" | "stop" | "restart"): string {
  if (action === "start") return "Starting";
  if (action === "stop") return "Stopping";
  return "Restarting";
}

function databaseConnectRetryable(state: string): boolean {
  return ["creating", "provisioning", "starting", "restarting"].includes(state);
}

function databaseConnectError(database: Database): {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    state: string;
    resource_id: string;
  };
} {
  const state = database.state ?? "unknown";
  return {
    ok: false,
    error: {
      code: "DATABASE_NOT_RUNNING",
      message: `Database ${database.id} is ${state}; connection credentials are only available once it is running.`,
      retryable: databaseConnectRetryable(state),
      state,
      resource_id: database.id,
    },
  };
}

function normalizeEngine(engine: string): string {
  const normalized = engine.trim().toLowerCase();
  return normalized === "postgres" ? "postgresql" : normalized;
}

function defaultEngineVersion(engine: string, version?: string): string | undefined {
  if (version) return version;
  return normalizeEngine(engine) === "postgresql" ? "16" : undefined;
}

function buildDatabaseUrl(creds: DatabaseCredentials): string | null {
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

  const host = creds.host;
  const database = creds.database ?? creds.dbname ?? creds.name;
  const username = creds.username ?? creds.user;
  if (!host || !database || !username) return null;
  const port = creds.port ?? 5432;
  const password = creds.password ? `:${encodeURIComponent(creds.password)}` : "";
  return `postgresql://${encodeURIComponent(username)}${password}@${host}:${port}/${database}`;
}

function normalizePostgresUrl(url: string): string {
  return url.startsWith("postgres://")
    ? `postgresql://${url.slice("postgres://".length)}`
    : url;
}

function unwrapMetrics(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && "data" in raw) {
    const data = (raw as Record<string, unknown>)["data"];
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function renderDatabaseMetrics(raw: unknown): void {
  const root = unwrapMetrics(raw);
  const current =
    root["current"] && typeof root["current"] === "object"
      ? (root["current"] as Record<string, unknown>)
      : {};

  console.log();
  console.log(chalk.bold("Database metrics"));
  console.log();
  console.log(
    `  ${chalk.bold("database_id")}   ${root["database_id"] ?? root["resource_id"] ?? "-"}`,
  );
  console.log(`  ${chalk.bold("window")}        ${root["window"] ?? "1h"}`);
  console.log(`  ${chalk.bold("state")}         ${formatMetricState(current["state"])}`);
  console.log(
    `  ${chalk.bold("engine")}        ${[current["engine"], current["engine_version"]].filter(Boolean).join(" ") || chalk.dim("-")}`,
  );
  console.log(`  ${chalk.bold("cpu")}           ${formatMetricValue(current["cpu_count"])}`);
  console.log(`  ${chalk.bold("memory")}        ${formatMb(current["memory_mb"])}`);
  console.log(`  ${chalk.bold("storage")}       ${formatMb(current["storage_mb"])}`);
  console.log(`  ${chalk.bold("port")}          ${formatMetricValue(current["port"])}`);
  console.log(`  ${chalk.bold("uptime")}        ${formatSeconds(current["uptime_sec"])}`);
  console.log(`  ${chalk.bold("node")}          ${formatMetricValue(current["node_id"])}`);
  console.log(`  ${chalk.bold("ip")}            ${formatMetricValue(current["ip_address"])}`);
  console.log();
}

function formatMetricState(value: unknown): string {
  const state = String(value ?? "unknown");
  if (["running", "available", "active", "healthy"].includes(state)) {
    return chalk.green(state);
  }
  if (["creating", "provisioning", "starting", "restarting"].includes(state)) {
    return chalk.yellow(state);
  }
  if (["failed", "error", "unhealthy"].includes(state)) {
    return chalk.red(state);
  }
  return state;
}

function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return chalk.dim("-");
  return String(value);
}

function formatMb(value: unknown): string {
  if (typeof value !== "number") return formatMetricValue(value);
  return formatBytes(value * 1024 * 1024);
}

function formatSeconds(value: unknown): string {
  if (typeof value !== "number") return formatMetricValue(value);
  return formatDuration(value * 1000);
}

export function register(program: Command): void {
  const databases = program
    .command("databases")
    .description("Manage managed databases");

  // list
  databases
    .command("list")
    .description("List databases")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = isJsonMode(opts) ? null : spin("Fetching databases...");
        const rows = unwrapDatabases(await client.apiGet("/api/v1/databases"));
        spinner?.stop();

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (d) => d.id.slice(0, 12), width: 14 },
          { header: "NAME", key: "name", width: 24 },
          {
            header: "ENGINE",
            key: (d) =>
              [d.engine, d.engine_version].filter(Boolean).join(" ") ||
              chalk.dim("unknown"),
            width: 16,
          },
          {
            header: "REGION",
            key: (d) => d.region ?? chalk.dim("default"),
            width: 14,
          },
          {
            header: "ENVIRONMENT",
            key: (d) => d.environment_id?.slice(0, 12) ?? chalk.dim("-"),
            width: 14,
          },
          { header: "STATE", key: fmtState, width: 12 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // create
  databases
    .command("create")
    .description("Create a managed database")
    .requiredOption("--name <name>", "Database name")
    .option(
      "--engine <engine>",
      "Database engine (postgres/postgresql, mysql, redis)",
      "postgresql",
    )
    .option("--engine-version <version>", "Engine version")
    .option("--db-version <version>", "Alias for --engine-version")
    .option("--region <region>", "Region ID")
    .option("--workspace <workspace-id>", "Workspace ID")
    .option("--environment <environment-id>", "Deployment environment ID")
    .option("--wait", "Wait until the database is ready")
    .option("--timeout <seconds>", "Wait timeout in seconds", parseIntegerOption, 120)
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        name: string;
        engine: string;
        engineVersion?: string;
        dbVersion?: string;
        region?: string;
        workspace?: string;
        environment?: string;
        wait?: boolean;
        timeout: number;
        json?: boolean;
      }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = isJsonMode(opts) ? null : spin(`Creating database ${opts.name}...`);
          const engine = normalizeEngine(opts.engine);
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
          if (opts.workspace) body["workspace_id"] = opts.workspace;
          if (opts.environment) body["environment_id"] = opts.environment;

          let db = unwrapDatabase(
            await client.apiPost("/api/v1/databases", body),
          );
          spinner?.succeed(`Created database ${db.name ?? db.id}`);

          if (opts.wait) {
            db = await waitForDatabaseReady(client, db.id, opts.timeout);
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(db, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}      ${db.id}`);
          console.log(`  ${chalk.bold("Name")}    ${db.name}`);
          console.log(`  ${chalk.bold("Engine")}  ${db.engine ?? engine}`);
          console.log(`  ${chalk.bold("State")}   ${db.state ?? "creating"}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // get
  databases
    .command("get <id>")
    .description("Get database details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const db = unwrapDatabase(
          await client.apiGet(`/api/v1/databases/${encodeURIComponent(id)}`),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(db, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}              ${db.id}`);
        console.log(`  ${chalk.bold("Name")}            ${db.name}`);
        console.log(
          `  ${chalk.bold("Engine")}          ${[db.engine, db.engine_version].filter(Boolean).join(" ") || chalk.dim("unknown")}`,
        );
        console.log(
          `  ${chalk.bold("Region")}          ${db.region ?? chalk.dim("default")}`,
        );
        console.log(`  ${chalk.bold("State")}           ${fmtState(db)}`);
        if (db.created_at)
          console.log(`  ${chalk.bold("Created")}         ${db.created_at}`);
        console.log();
        console.log(
          chalk.dim(
            `  Run "miosa databases connect ${id}" to get the connection string.`,
          ),
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // metrics
  databases
    .command("metrics <id>")
    .description("Show managed database resource, uptime, and endpoint metrics")
    .option("--window <window>", "Metrics window: 1h, 24h, or 7d", "1h")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        opts: { window: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const json = isJsonMode(opts);
          const spinner = json ? null : spin("Fetching database metrics...");
          const metrics = await client.apiGet(
            `/api/v1/databases/${encodeURIComponent(id)}/metrics?window=${encodeURIComponent(opts.window)}`,
          );
          spinner?.stop();

          if (json) {
            console.log(JSON.stringify(metrics, null, 2));
            return;
          }

          renderDatabaseMetrics(metrics);
        } catch (err) {
          handleError(err);
        }
      },
    );

  const lifecycleAction =
    (action: "start" | "stop" | "restart") =>
    async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = isJsonMode(opts)
          ? null
          : spin(`${lifecycleVerb(action)} database...`);
        const db = unwrapDatabase(
          await client.apiPost(
            `/api/v1/databases/${encodeURIComponent(id)}/${action}`,
            {},
          ),
        );
        spinner?.succeed(`Database ${action} requested`);

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(db, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}      ${db.id}`);
        console.log(`  ${chalk.bold("State")}   ${db.state ?? "unknown"}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    };

  databases
    .command("start <id>")
    .description("Start a stopped or errored database")
    .option("--json", "Output raw JSON")
    .action(lifecycleAction("start"));

  databases
    .command("stop <id>")
    .description("Stop a running database")
    .option("--json", "Output raw JSON")
    .action(lifecycleAction("stop"));

  databases
    .command("restart <id>")
    .description("Restart a managed database")
    .option("--json", "Output raw JSON")
    .action(lifecycleAction("restart"));

  databases
    .command("wait <id>")
    .description("Wait for a database to become ready")
    .option("--ready", "Wait for running state and successful connection test", true)
    .option("--timeout <seconds>", "Wait timeout in seconds", parseIntegerOption, 120)
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        opts: { ready?: boolean; timeout: number; json?: boolean },
      ) => {
        try {
          void opts.ready;
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = isJsonMode(opts) ? null : spin("Waiting for database...");
          const db = await waitForDatabaseReady(client, id, opts.timeout);
          spinner?.succeed("Database ready");

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(db, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}      ${db.id}`);
          console.log(`  ${chalk.bold("State")}   ${db.state ?? "running"}`);
          if (db.connection_test?.host) {
            console.log(
              `  ${chalk.bold("Endpoint")} ${db.connection_test.host}:${db.connection_test.port ?? ""}`,
            );
          }
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // connect — print connection string
  databases
    .command("connect <id>")
    .description("Show connection string for a database")
    .option("--print-url", "Print only the connection URL")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { printUrl?: boolean; json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner =
          isJsonMode(opts) || opts.printUrl ? null : spin("Fetching credentials...");
        const database = unwrapDatabase(
          await client.apiGet(`/api/v1/databases/${encodeURIComponent(id)}`),
        );

        if (database.state !== "running" && database.state !== "available") {
          spinner?.stop();
          const error = databaseConnectError(database);

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(error, null, 2));
          } else {
            console.error(chalk.red(error.error.message));
          }

          process.exit(1);
        }

        const creds = unwrapCredentials(
          await client.apiGet(
            `/api/v1/databases/${encodeURIComponent(id)}/credentials`,
          ),
        );
        spinner?.stop();

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(creds, null, 2));
          return;
        }

        const url = buildDatabaseUrl(creds);

        if (opts.printUrl) {
          if (!url) {
            throw new Error(
              "Could not construct a connection URL from the credentials returned by the API. Use --json to inspect raw credentials.",
            );
          }
          console.log(url);
          return;
        }

        if (url) {
          console.log();
          console.log(`  ${chalk.bold("URL")}       ${url}`);
          console.log();
        } else {
          console.log();
          if (creds.host)
            console.log(`  ${chalk.bold("Host")}      ${creds.host}`);
          if (creds.port !== undefined)
            console.log(`  ${chalk.bold("Port")}      ${creds.port}`);
          const database = creds.database ?? creds.dbname ?? creds.name;
          const username = creds.username ?? creds.user;
          if (database)
            console.log(`  ${chalk.bold("Database")} ${database}`);
          if (username)
            console.log(`  ${chalk.bold("User")}      ${username}`);
          if (creds.password)
            console.log(`  ${chalk.bold("Password")} ${creds.password}`);
          console.log();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // delete
  databases
    .command("delete <id>")
    .description("Delete a database")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
      try {
        if (!opts.force) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: chalk.red(
                `Delete database ${id}? This is irreversible.`,
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
        const spinner = isJsonMode(opts) ? null : spin("Deleting database...");
        const result = await client.apiDelete(
          `/api/v1/databases/${encodeURIComponent(id)}`,
        );
        spinner?.succeed("Database deleted");
        if (isJsonMode(opts))
          console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });

  // backup
  databases
    .command("backup <id>")
    .description("Trigger a manual backup for a database")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = isJsonMode(opts) ? null : spin("Triggering backup...");
        const result = await client.apiPost(
          `/api/v1/databases/${encodeURIComponent(id)}/backup`,
          {},
        );
        spinner?.succeed("Backup started");

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const r = result as Record<string, unknown>;
        const backupId =
          typeof r["id"] === "string"
            ? r["id"]
            : typeof r["backup_id"] === "string"
              ? r["backup_id"]
              : null;

        console.log();
        if (backupId) console.log(`  ${chalk.bold("Backup ID")}  ${backupId}`);
        console.log(
          `  ${chalk.bold("Status")}     ${typeof r["status"] === "string" ? r["status"] : "pending"}`,
        );
        console.log();
        if (backupId) {
          console.log(
            chalk.dim(
              `  Run "miosa databases restore ${id} ${backupId}" to restore from this backup.`,
            ),
          );
          console.log();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // restore
  databases
    .command("restore <id> <backup-id>")
    .description("Restore a database from a backup")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        backupId: string,
        opts: { force?: boolean; json?: boolean },
      ) => {
        try {
          if (!opts.force) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.red(
                  `Restore database ${id} from backup ${backupId}? Current data will be overwritten.`,
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
          const spinner = isJsonMode(opts) ? null : spin("Triggering restore...");
          const result = await client.apiPost(
            `/api/v1/databases/${encodeURIComponent(id)}/restore`,
            { backup_id: backupId },
          );
          spinner?.succeed("Restore started");

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          const r = result as Record<string, unknown>;
          console.log();
          console.log(`  ${chalk.bold("Database")}   ${id}`);
          console.log(`  ${chalk.bold("Backup")}     ${backupId}`);
          console.log(
            `  ${chalk.bold("Status")}     ${typeof r["status"] === "string" ? r["status"] : "restoring"}`,
          );
          console.log();
          console.log(
            chalk.dim(
              `  Run "miosa databases get ${id}" to monitor restore progress.`,
            ),
          );
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // logs
  databases
    .command("logs <id>")
    .description("Show recent managed database logs")
    .option("--lines <n>", "Number of lines to fetch", parseIntegerOption, 100)
    .option("--follow", "Follow live logs with SSE")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { lines: number; follow?: boolean; json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        if (!opts.follow) {
          const lines = Math.max(1, Math.min(opts.lines, 500));
          const result = unwrapLogs(
            await client.apiGet(
              `/api/v1/databases/${encodeURIComponent(id)}/logs?lines=${lines}`,
            ),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (result.logs.length === 0) {
            console.log(chalk.dim("No database logs."));
            return;
          }

          for (const entry of result.logs) {
            console.log(formatLogEntry(entry));
          }
          return;
        }

        if (!isJsonMode(opts)) {
          console.log(chalk.dim(`Streaming logs for database ${id}...`));
        }

        // Use undici directly to get an SSE response
        const { request } = await import("undici");
        const endpoint = config.endpoint;
        const apiKey = config.api_key ?? "";
        const url = `${endpoint.replace(/\/$/, "")}/api/v1/databases/${encodeURIComponent(id)}/logs/stream`;

        const res = await request(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "text/event-stream, application/json, */*",
            "User-Agent": CLI_USER_AGENT,
          },
        });

        if (res.statusCode >= 400) {
          const body = await res.body.text();
          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: `HTTP_${res.statusCode}`,
                    message: body || `HTTP ${res.statusCode}`,
                    retryable: res.statusCode >= 500,
                  },
                },
                null,
                2,
              ),
            );
            process.exit(1);
          }
          console.error(chalk.red(`HTTP ${res.statusCode}: ${body}`));
          if (res.statusCode === 406) {
            console.error(
              chalk.yellow(
                "Database logs endpoint rejected the requested response format. The CLI now accepts SSE, JSON, or text; if this persists, the API route is returning a format negotiation error.",
              ),
            );
          }
          process.exit(1);
        }

        for await (const event of parseSse(res.body)) {
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(event));
            continue;
          }
          switch (event.type) {
            case "stdout":
              process.stdout.write(event.data);
              break;
            case "stderr":
              process.stderr.write(chalk.red(event.data));
              break;
            case "error":
              console.error(chalk.red(event.message));
              break;
            case "done":
              return;
            case "unknown":
              try {
                const parsed = JSON.parse(event.raw) as Record<string, unknown>;
                const line =
                  typeof parsed["line"] === "string"
                    ? parsed["line"]
                    : typeof parsed["message"] === "string"
                      ? parsed["message"]
                      : null;
                if (line) {
                  const isErr =
                    parsed["stream"] === "stderr" ||
                    parsed["level"] === "error";
                  if (isErr) process.stderr.write(chalk.red(line) + "\n");
                  else process.stdout.write(line + "\n");
                }
              } catch {
                // Ignore malformed frames
              }
              break;
            default:
              break;
          }
        }
      } catch (err) {
        handleError(err);
      }
    });
}
