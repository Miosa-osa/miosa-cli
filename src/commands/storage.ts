import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface Bucket {
  id: string;
  name: string;
  visibility?: string;
  region?: string;
  object_count?: number;
  size_bytes?: number;
  created_at?: string;
}

function unwrapBuckets(
  raw: { data?: Bucket[]; buckets?: Bucket[] } | Bucket[],
): Bucket[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.buckets ?? [];
}

function unwrapBucket(
  raw: { data?: Bucket; bucket?: Bucket } | Bucket,
): Bucket {
  if ("data" in raw && raw.data) return raw.data;
  if ("bucket" in raw && raw.bucket) return raw.bucket;
  return raw as Bucket;
}

function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined) return chalk.dim("-");
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function register(program: Command): void {
  const storage = program
    .command("storage")
    .description("Manage object storage buckets");

  // list
  storage
    .command("list")
    .description("List storage buckets")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching buckets...");
        const rows = unwrapBuckets(
          await client.apiGet("/api/v1/storage/buckets"),
        );
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (b) => b.id.slice(0, 12), width: 14 },
          { header: "NAME", key: "name", width: 28 },
          {
            header: "VISIBILITY",
            key: (b) => {
              const v = b.visibility ?? "private";
              return v === "public" ? chalk.cyan(v) : chalk.dim(v);
            },
            width: 12,
          },
          {
            header: "REGION",
            key: (b) => b.region ?? chalk.dim("default"),
            width: 14,
          },
          {
            header: "OBJECTS",
            key: (b) =>
              b.object_count !== undefined
                ? String(b.object_count)
                : chalk.dim("-"),
            width: 10,
          },
          { header: "SIZE", key: (b) => fmtSize(b.size_bytes), width: 10 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // create
  storage
    .command("create")
    .description("Create a storage bucket")
    .requiredOption("--name <name>", "Bucket name")
    .option("--public", "Make bucket publicly readable")
    .option("--region <region>", "Region ID")
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        name: string;
        public?: boolean;
        region?: string;
        json?: boolean;
      }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin(`Creating bucket ${opts.name}...`);
          const body: Record<string, unknown> = {
            name: opts.name,
            visibility: opts.public ? "public" : "private",
          };
          if (opts.region) body["region"] = opts.region;

          const bucket = unwrapBucket(
            await client.apiPost("/api/v1/storage/buckets", body),
          );
          spinner.succeed(`Created bucket ${bucket.name}`);

          if (opts.json) {
            console.log(JSON.stringify(bucket, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}           ${bucket.id}`);
          console.log(`  ${chalk.bold("Name")}         ${bucket.name}`);
          console.log(
            `  ${chalk.bold("Visibility")}  ${bucket.visibility ?? (opts.public ? "public" : "private")}`,
          );
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // get
  storage
    .command("get <id>")
    .description("Get storage bucket details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const bucket = unwrapBucket(
          await client.apiGet(
            `/api/v1/storage/buckets/${encodeURIComponent(id)}`,
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(bucket, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}           ${bucket.id}`);
        console.log(`  ${chalk.bold("Name")}         ${bucket.name}`);
        console.log(
          `  ${chalk.bold("Visibility")}  ${bucket.visibility ?? chalk.dim("private")}`,
        );
        console.log(
          `  ${chalk.bold("Region")}       ${bucket.region ?? chalk.dim("default")}`,
        );
        console.log(
          `  ${chalk.bold("Objects")}      ${bucket.object_count !== undefined ? bucket.object_count : chalk.dim("-")}`,
        );
        console.log(
          `  ${chalk.bold("Size")}         ${fmtSize(bucket.size_bytes)}`,
        );
        if (bucket.created_at)
          console.log(`  ${chalk.bold("Created")}      ${bucket.created_at}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // delete
  storage
    .command("delete <id>")
    .description("Delete a storage bucket")
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
                `Delete bucket ${id}? All objects will be lost.`,
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
        const spinner = spin("Deleting bucket...");
        const result = await client.apiDelete(
          `/api/v1/storage/buckets/${encodeURIComponent(id)}`,
        );
        spinner.succeed("Bucket deleted");
        if (opts.json)
          console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });
}
