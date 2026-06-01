import type { Command } from "commander";
import chalk from "chalk";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, isJsonMode, printJson } from "./util.js";

interface Bucket {
  id: string;
  name: string;
  visibility?: string;
  region?: string;
  object_count?: number;
  size_bytes?: number;
  created_at?: string;
}

interface StorageObject {
  key: string;
  size?: number;
  content_type?: string;
  last_modified?: string;
  etag?: string;
}

interface PresignResult {
  url?: string;
  presigned_url?: string;
  expires_at?: string;
  expires_in?: number;
}

function unwrapObjects(
  raw: { data?: StorageObject[]; objects?: StorageObject[] } | StorageObject[],
): StorageObject[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.objects ?? [];
}

function unwrapPresign(
  raw:
    | { data?: PresignResult; url?: string; presigned_url?: string }
    | PresignResult,
): PresignResult {
  if ("data" in raw && raw.data) return raw.data;
  return raw as PresignResult;
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
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching buckets...");
        const rows = unwrapBuckets(
          await client.apiGet("/api/v1/storage/buckets"),
        );
        spinner?.stop();

        if (json) {
          printJson(rows);
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
          const json = isJsonMode(opts);
          const spinner = json ? null : spin(`Creating bucket ${opts.name}...`);
          const body: Record<string, unknown> = {
            name: opts.name,
            visibility: opts.public ? "public" : "private",
          };
          if (opts.region) body["region"] = opts.region;

          const bucket = unwrapBucket(
            await client.apiPost("/api/v1/storage/buckets", body),
          );
          spinner?.succeed(`Created bucket ${bucket.name}`);

          if (json) {
            printJson(bucket);
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

        if (isJsonMode(opts)) {
          printJson(bucket);
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
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Deleting bucket...");
        const result = await client.apiDelete(
          `/api/v1/storage/buckets/${encodeURIComponent(id)}`,
        );
        spinner?.succeed("Bucket deleted");
        if (json) printJson(result ?? { ok: true });
      } catch (err) {
        handleError(err);
      }
    });

  // objects list
  storage
    .command("objects <bucket-id>")
    .description("List objects in a storage bucket")
    .option("--json", "Output raw JSON")
    .action(async (bucketId: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching objects...");
        const rows = unwrapObjects(
          await client.apiGet(
            `/api/v1/storage/buckets/${encodeURIComponent(bucketId)}/objects`,
          ),
        );
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No objects found."));
          return;
        }

        renderTable(rows, [
          { header: "KEY", key: "key", width: 40 },
          { header: "SIZE", key: (o) => fmtSize(o.size), width: 10 },
          {
            header: "TYPE",
            key: (o) => o.content_type ?? chalk.dim("-"),
            width: 24,
          },
          {
            header: "LAST MODIFIED",
            key: (o) =>
              o.last_modified
                ? o.last_modified.slice(0, 19).replace("T", " ")
                : chalk.dim("-"),
            width: 20,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // upload
  storage
    .command("upload <bucket-id> <local-path>")
    .description("Upload a file to a storage bucket")
    .option("--key <remote-key>", "Object key (defaults to filename)")
    .option("--json", "Output raw JSON")
    .action(
      async (
        bucketId: string,
        localPath: string,
        opts: { key?: string; json?: boolean },
      ) => {
        try {
          // Verify the local file exists and get its size
          let fileSize: number;
          try {
            const info = await stat(localPath);
            fileSize = info.size;
          } catch {
          if (isJsonMode(opts)) {
            printJson({
              ok: false,
              error: {
                code: "FILE_NOT_FOUND",
                message: `File not found: ${localPath}`,
                retryable: false,
              },
            });
          } else {
            console.error(chalk.red(`File not found: ${localPath}`));
          }
          process.exit(1);
          }

          const objectKey = opts.key ?? basename(localPath);
          const config = loadConfig();
          const client = new MiosaClient(config);
          const json = isJsonMode(opts);
          const spinner = json
            ? null
            : spin(`Uploading ${basename(localPath)} (${fmtSize(fileSize)})...`);

          // Read the file and upload via PUT
          const { readFile } = await import("node:fs/promises");
          const data = await readFile(localPath);

          const result = await client.apiPut(
            `/api/v1/storage/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectKey)}`,
            data,
          );
          spinner?.succeed(`Uploaded → ${objectKey}`);

          if (json) {
            printJson(result ?? { key: objectKey });
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Bucket")}  ${bucketId}`);
          console.log(`  ${chalk.bold("Key")}     ${objectKey}`);
          console.log(`  ${chalk.bold("Size")}    ${fmtSize(fileSize)}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // download
  storage
    .command("download <bucket-id> <key>")
    .description("Download an object from a storage bucket")
    .option("--output <local-path>", "Local path to write the file")
    .option("--json", "Output raw JSON metadata")
    .action(
      async (
        bucketId: string,
        key: string,
        opts: { output?: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const outputPath = opts.output ?? basename(key);
          const json = isJsonMode(opts);
          const spinner = json ? null : spin(`Downloading ${key}...`);

          // Use undici request directly for streaming the binary response
          const { request } = await import("undici");
          const { pipeline } = await import("node:stream/promises");

          const endpoint = config.endpoint;
          const apiKey = config.api_key ?? "";
          const url = `${endpoint.replace(/\/$/, "")}/api/v1/storage/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(key)}`;

          const res = await request(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "User-Agent": "@miosa/cli/0.1.0",
            },
          });

          if (res.statusCode >= 400) {
            spinner?.fail("Download failed");
            const body = await res.body.text();
            if (json) {
              printJson({
                ok: false,
                error: {
                  code: "HTTP_ERROR",
                  message: `HTTP ${res.statusCode}: ${body}`,
                  retryable: res.statusCode >= 500,
                },
              });
            } else {
              console.error(chalk.red(`HTTP ${res.statusCode}: ${body}`));
            }
            process.exit(1);
          }

          const outStream = createWriteStream(outputPath);
          await pipeline(res.body, outStream);
          spinner?.succeed(`Downloaded → ${outputPath}`);

          if (json) {
            printJson({ key, output: outputPath, bucket: bucketId });
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Key")}     ${key}`);
          console.log(`  ${chalk.bold("Saved")}   ${outputPath}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // delete-object
  storage
    .command("delete-object <bucket-id> <key>")
    .description("Delete an object from a storage bucket")
    .option("--json", "Output raw JSON")
    .action(async (bucketId: string, key: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin(`Deleting ${key}...`);
        const result = await client.apiDelete(
          `/api/v1/storage/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(key)}`,
        );
        spinner?.succeed(`Deleted ${key}`);
        if (json) printJson(result ?? { ok: true });
      } catch (err) {
        handleError(err);
      }
    });

  // presign
  storage
    .command("presign <bucket-id> <key>")
    .description("Generate a presigned URL for an object")
    .option("--expires <seconds>", "URL expiry in seconds", "3600")
    .option("--json", "Output raw JSON")
    .action(
      async (
        bucketId: string,
        key: string,
        opts: { expires: string; json?: boolean },
      ) => {
        try {
          const expiresIn = parseInt(opts.expires, 10);
          if (isNaN(expiresIn) || expiresIn <= 0) {
            if (isJsonMode(opts)) {
              printJson({
                ok: false,
                error: {
                  code: "INVALID_ARGUMENT",
                  message: "--expires must be a positive integer (seconds)",
                  retryable: false,
                },
              });
            } else {
              console.error(
                chalk.red("--expires must be a positive integer (seconds)"),
              );
            }
            process.exit(1);
          }

          const config = loadConfig();
          const client = new MiosaClient(config);
          const json = isJsonMode(opts);
          const spinner = json ? null : spin("Generating presigned URL...");
          const presign = unwrapPresign(
            await client.apiPost(
              `/api/v1/storage/buckets/${encodeURIComponent(bucketId)}/presign`,
              { key, expires_in: expiresIn },
            ),
          );
          spinner?.stop();

          const url = presign.url ?? presign.presigned_url;

          if (json) {
            printJson(presign);
            return;
          }

          if (!url) {
            console.error(chalk.red("No presigned URL returned by the API."));
            process.exit(1);
          }

          console.log();
          console.log(`  ${chalk.bold("Key")}      ${key}`);
          console.log(`  ${chalk.bold("Expires")}  ${expiresIn}s`);
          console.log(`  ${chalk.bold("URL")}      ${chalk.cyan(url)}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );
}
