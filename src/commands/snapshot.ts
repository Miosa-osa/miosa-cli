/**
 * miosa snapshot — checkpoint/restore workflow for Computers.
 *
 * This is a polished UX wrapper around the checkpoints API, providing
 * human-readable sizes, timing, progress bars, and a new `export` subcommand.
 * The raw `miosa checkpoints` commands remain available for scripting.
 */

import type { Command } from "commander";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import { ProgressBar, formatBytes } from "../ui/progress.js";
import { enc } from "./enterprise-util.js";
import { NetworkError } from "../errors.js";
import { request } from "undici";
import type { ComputerCheckpoint } from "../types.js";

// ── helpers ────────────────────────────────────────────────────────────────

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatSnapshotSize(bytes: number | null | undefined): string {
  if (bytes == null) return chalk.dim("—");
  return formatBytes(bytes);
}

// ── register ───────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const snapshot = program
    .command("snapshot")
    .alias("snap")
    .description(
      "Checkpoint and restore Computer state (Firecracker snapshots)",
    );

  // ── create ───────────────────────────────────────────────────────────────

  snapshot
    .command("create <computer-id>")
    .description("Checkpoint the current state of a running Computer")
    .option("--name <name>", "Human-readable name for this snapshot")
    .option("--json", "Output as JSON")
    .action(
      async (
        computerId: string,
        opts: { name?: string; json?: boolean },
      ): Promise<void> => {
        try {
          const client = new MiosaClient(loadConfig());
          const spinner = spin(
            opts.name
              ? `Creating snapshot "${opts.name}"...`
              : "Creating snapshot...",
          );
          const start = Date.now();

          const result = await client.apiPost<{ data: ComputerCheckpoint }>(
            `/api/v1/computers/${enc(computerId)}/checkpoints`,
            opts.name ? { comment: opts.name } : {},
          );

          const elapsed = Date.now() - start;
          const checkpoint = result.data;

          if (opts.json) {
            spinner.stop();
            console.log(JSON.stringify(checkpoint, null, 2));
            return;
          }

          const sizeStr = formatSnapshotSize(checkpoint.size_bytes);
          const timingStr = chalk.dim(`${elapsed}ms`);
          spinner.succeed(
            `Snapshot created: ${chalk.cyan(checkpoint.id)} (${sizeStr}, ${timingStr})`,
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── ls ───────────────────────────────────────────────────────────────────

  snapshot
    .command("ls <computer-id>")
    .alias("list")
    .description("List snapshots for a Computer")
    .option("--json", "Output as JSON")
    .action(
      async (computerId: string, opts: { json?: boolean }): Promise<void> => {
        try {
          const client = new MiosaClient(loadConfig());
          const result = await client.apiGet<{
            data: ComputerCheckpoint[];
          }>(`/api/v1/computers/${enc(computerId)}/checkpoints`);

          const checkpoints = result.data;

          if (opts.json) {
            console.log(JSON.stringify(checkpoints, null, 2));
            return;
          }

          if (checkpoints.length === 0) {
            console.log(chalk.dim("No snapshots found."));
            return;
          }

          renderTable<ComputerCheckpoint>(checkpoints, [
            {
              header: "NAME",
              key: (c) => c.comment ?? chalk.dim("(unnamed)"),
              width: 24,
            },
            {
              header: "SIZE",
              key: (c) => formatSnapshotSize(c.size_bytes),
              width: 10,
            },
            {
              header: "CREATED",
              key: (c) => formatAge(c.inserted_at),
              width: 20,
            },
            {
              header: "ID",
              key: "id",
              width: 16,
            },
          ]);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── restore ──────────────────────────────────────────────────────────────

  snapshot
    .command("restore <computer-id> <snapshot-id>")
    .description("Restore a Computer from a snapshot")
    .option("--json", "Output as JSON")
    .action(
      async (
        computerId: string,
        snapshotId: string,
        opts: { json?: boolean },
      ): Promise<void> => {
        try {
          const client = new MiosaClient(loadConfig());

          // Fetch the snapshot name for the spinner label if possible
          let label = snapshotId;
          try {
            const snap = await client.apiGet<{ data: ComputerCheckpoint }>(
              `/api/v1/computers/${enc(computerId)}/checkpoints/${enc(snapshotId)}`,
            );
            if (snap.data.comment) label = snap.data.comment;
          } catch {
            // Best-effort — don't fail if we can't look up the name
          }

          const spinner = spin(`Restoring from ${label}...`);
          const start = Date.now();

          const result = await client.apiPost<{ data: ComputerCheckpoint }>(
            `/api/v1/computers/${enc(computerId)}/restore/${enc(snapshotId)}`,
            {},
          );

          const elapsed = Date.now() - start;

          if (opts.json) {
            spinner.stop();
            console.log(JSON.stringify(result.data, null, 2));
            return;
          }

          spinner.succeed(
            `Restoring from ${label}... ${chalk.green("done")} (${chalk.dim(`${elapsed}ms`)})`,
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── delete ───────────────────────────────────────────────────────────────

  snapshot
    .command("delete <computer-id> <snapshot-id>")
    .alias("rm")
    .description("Delete a snapshot")
    .option("--json", "Output as JSON")
    .action(
      async (
        computerId: string,
        snapshotId: string,
        opts: { json?: boolean },
      ): Promise<void> => {
        try {
          const client = new MiosaClient(loadConfig());

          // Resolve name for nicer output
          let label = snapshotId;
          try {
            const snap = await client.apiGet<{ data: ComputerCheckpoint }>(
              `/api/v1/computers/${enc(computerId)}/checkpoints/${enc(snapshotId)}`,
            );
            if (snap.data.comment) label = snap.data.comment;
          } catch {
            // Best-effort
          }

          await client.apiDelete<unknown>(
            `/api/v1/computers/${enc(computerId)}/checkpoints/${enc(snapshotId)}`,
          );

          if (opts.json) {
            console.log(
              JSON.stringify({ deleted: true, id: snapshotId }, null, 2),
            );
            return;
          }

          console.log(`${chalk.green("Deleted:")} ${label}`);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── export ───────────────────────────────────────────────────────────────

  snapshot
    .command("export <computer-id> <snapshot-id>")
    .description("Download a snapshot archive to disk")
    .requiredOption("--output <path>", "Local path to write the snapshot file")
    .option("--json", "Output as JSON")
    .action(
      async (
        computerId: string,
        snapshotId: string,
        opts: { output: string; json?: boolean },
      ): Promise<void> => {
        try {
          const config = loadConfig();
          const endpoint = config.endpoint.replace(/\/$/, "");
          const apiKey = config.api_key;

          if (!apiKey) {
            throw new Error("Not authenticated. Run: miosa auth login");
          }

          const url = `${endpoint}/api/v1/computers/${enc(computerId)}/checkpoints/${enc(snapshotId)}/export`;

          let res: Awaited<ReturnType<typeof request>>;
          try {
            res = await request(url, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "User-Agent": "@miosa/cli/0.1.0",
              },
            });
          } catch (err) {
            throw new NetworkError(
              `Network error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (res.statusCode >= 400) {
            const body = await res.body.text();
            throw new Error(`Export failed (HTTP ${res.statusCode}): ${body}`);
          }

          // Content-Length may not always be present but use it when available
          const contentLength = res.headers["content-length"];
          const totalBytes =
            typeof contentLength === "string" ? parseInt(contentLength, 10) : 0;

          if (opts.json) {
            // In JSON mode, we still need to stream — just don't show progress
            const dest = createWriteStream(opts.output);
            await pipeline(Readable.fromWeb(res.body as never), dest);
            console.log(
              JSON.stringify(
                { saved: opts.output, bytes: totalBytes },
                null,
                2,
              ),
            );
            return;
          }

          const bar = new ProgressBar("Exporting...");
          let bytesReceived = 0;

          const dest = createWriteStream(opts.output);

          // Stream with progress tracking
          const nodeReadable = Readable.fromWeb(res.body as never);
          const trackingStream = new Readable({
            read() {},
          });

          nodeReadable.on("data", (chunk: Buffer) => {
            bytesReceived += chunk.length;
            const total = totalBytes > 0 ? totalBytes : bytesReceived;
            bar.update(bytesReceived, total);
            trackingStream.push(chunk);
          });

          nodeReadable.on("end", () => {
            trackingStream.push(null);
          });

          nodeReadable.on("error", (err: Error) => {
            trackingStream.destroy(err);
          });

          await pipeline(trackingStream, dest);
          bar.done();

          console.log(
            `${chalk.green("Saved to")} ${chalk.cyan(opts.output)} ${chalk.dim(`(${formatBytes(bytesReceived)})`)}`,
          );
        } catch (err) {
          handleError(err);
        }
      },
    );
}
