import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface Database {
  id: string;
  name: string;
  engine?: string;
  engine_version?: string;
  state?: string;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

interface DatabaseCredentials {
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
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
        const spinner = spin("Fetching databases...");
        const rows = unwrapDatabases(await client.apiGet("/api/v1/databases"));
        spinner.stop();

        if (opts.json) {
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
      "Database engine (postgres, mysql, redis)",
      "postgres",
    )
    .option("--version <version>", "Engine version")
    .option("--region <region>", "Region ID")
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        name: string;
        engine: string;
        version?: string;
        region?: string;
        json?: boolean;
      }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin(`Creating database ${opts.name}...`);
          const body: Record<string, unknown> = {
            name: opts.name,
            engine: opts.engine,
          };
          if (opts.version) body["engine_version"] = opts.version;
          if (opts.region) body["region"] = opts.region;

          const db = unwrapDatabase(
            await client.apiPost("/api/v1/databases", body),
          );
          spinner.succeed(`Created database ${db.name}`);

          if (opts.json) {
            console.log(JSON.stringify(db, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}      ${db.id}`);
          console.log(`  ${chalk.bold("Name")}    ${db.name}`);
          console.log(`  ${chalk.bold("Engine")}  ${db.engine ?? opts.engine}`);
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

        if (opts.json) {
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

  // connect — print connection string
  databases
    .command("connect <id>")
    .description("Show connection string for a database")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
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

        if (creds.url) {
          console.log();
          console.log(`  ${chalk.bold("URL")}       ${creds.url}`);
          console.log();
        } else {
          console.log();
          if (creds.host)
            console.log(`  ${chalk.bold("Host")}      ${creds.host}`);
          if (creds.port !== undefined)
            console.log(`  ${chalk.bold("Port")}      ${creds.port}`);
          if (creds.database)
            console.log(`  ${chalk.bold("Database")} ${creds.database}`);
          if (creds.username)
            console.log(`  ${chalk.bold("User")}      ${creds.username}`);
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
        const spinner = spin("Deleting database...");
        const result = await client.apiDelete(
          `/api/v1/databases/${encodeURIComponent(id)}`,
        );
        spinner.succeed("Database deleted");
        if (opts.json)
          console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });
}
