import type { Command } from "commander";
import chalk from "chalk";
import {
  addDataOption,
  client,
  apiPath,
  enc,
  unwrap,
  runAction,
  type ApiObject,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { hintBlock, icon, kvPanel, printBanner } from "../ui/render.js";
import { renderTable } from "../ui/table.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtStatus(s: unknown): string {
  const str = String(s ?? "");
  if (str === "ready") return chalk.green(str);
  if (str === "creating") return chalk.yellow(str);
  if (str === "failed") return chalk.red(str);
  return chalk.dim(str || "—");
}

function fmtId(s: unknown): string {
  const str = String(s ?? "");
  return str ? chalk.dim(str.slice(0, 12)) : chalk.dim("—");
}

// ── register ─────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const checkpoints = program
    .command("checkpoints")
    .description("Manage Computer checkpoints (Firecracker snapshots)");

  // ── list ───────────────────────────────────────────────────────────────────
  checkpoints
    .command("list <computer-id>")
    .description("List all checkpoints for a Computer")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/computers/${enc(computerId)}/snapshots`),
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const rows = Array.isArray(value)
          ? (value.filter(
              (v) => v !== null && typeof v === "object" && !Array.isArray(v),
            ) as ApiObject[])
          : [];

        console.log();
        console.log(
          `  ${icon.info} ${chalk.bold(String(rows.length))} ${chalk.dim("checkpoint(s)")}  ${chalk.dim(`computer: ${computerId}`)}`,
        );
        console.log();

        renderTable<ApiObject>(rows, [
          { header: "ID", key: (r) => fmtId(r["id"]), width: 14 },
          {
            header: "NAME / COMMENT",
            key: (r) => String(r["comment"] ?? r["name"] ?? chalk.dim("—")),
          },
          { header: "STATUS", key: (r) => fmtStatus(r["status"]) },
          {
            header: "CREATED",
            key: (r) =>
              String(r["inserted_at"] ?? r["created_at"] ?? chalk.dim("—")),
          },
        ]);

        console.log();
        console.log(
          hintBlock("Try", [
            `miosa checkpoints create ${computerId} --name my-snap`,
            `miosa checkpoints get ${computerId} <checkpoint-id>`,
            `miosa checkpoints restore ${computerId} <checkpoint-id>`,
          ]),
        );
        console.log();
      }),
    );

  // ── create ─────────────────────────────────────────────────────────────────
  addDataOption(
    checkpoints
      .command("create <computer-id>")
      .description("Create a checkpoint of a running Computer")
      .option("--name <name>", "Optional name/comment for the checkpoint"),
  )
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: DataOptions & { name?: string }) =>
      runAction(async () => {
        const body = opts.name ? { comment: opts.name } : {};
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/computers/${enc(computerId)}/snapshots`),
            body,
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const snap = value as ApiObject;

        printBanner({ subtitle: "Checkpoint created" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "ID",
              value: chalk.bold(String(snap["id"] ?? "—")),
            },
            {
              icon: icon.ok,
              label: "Comment",
              value: String(snap["comment"] ?? snap["name"] ?? chalk.dim("—")),
            },
            {
              icon: icon.ok,
              label: "Status",
              value: fmtStatus(snap["status"]),
            },
            { label: "Computer", value: chalk.dim(computerId) },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Next", [
            `miosa checkpoints list ${computerId}`,
            `miosa checkpoints restore ${computerId} ${String(snap["id"] ?? "<checkpoint-id>")}`,
          ]),
        );
        console.log();
      }),
    );

  // ── get ────────────────────────────────────────────────────────────────────
  checkpoints
    .command("get <computer-id> <checkpoint-id>")
    .description("Show a single checkpoint")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiGet<unknown>(
            apiPath(
              `/computers/${enc(computerId)}/snapshots/${enc(checkpointId)}`,
            ),
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const snap = value as ApiObject;

        printBanner({ subtitle: "Checkpoint" });
        console.log(
          kvPanel([
            { label: "ID", value: chalk.bold(String(snap["id"] ?? "—")) },
            {
              label: "Comment",
              value: String(snap["comment"] ?? snap["name"] ?? chalk.dim("—")),
            },
            { label: "Status", value: fmtStatus(snap["status"]) },
            { label: "Computer", value: chalk.dim(computerId) },
            {
              label: "Created",
              value: chalk.dim(
                String(snap["inserted_at"] ?? snap["created_at"] ?? "—"),
              ),
            },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Try", [
            `miosa checkpoints restore ${computerId} ${checkpointId}`,
            `miosa checkpoints delete ${computerId} ${checkpointId}`,
          ]),
        );
        console.log();
      }),
    );

  // ── restore ────────────────────────────────────────────────────────────────
  checkpoints
    .command("restore <computer-id> <checkpoint-id>")
    .description("Restore a checkpoint onto a fresh Computer")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(
              `/computers/${enc(computerId)}/restore/${enc(checkpointId)}`,
            ),
            {},
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const res = value as ApiObject;

        printBanner({ subtitle: "Restore initiated" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "Checkpoint",
              value: chalk.bold(checkpointId),
            },
            { icon: icon.ok, label: "Computer", value: chalk.dim(computerId) },
            {
              icon: icon.ok,
              label: "Status",
              value: fmtStatus(res["status"] ?? "restoring"),
            },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Next", [
            `miosa computers show ${computerId}`,
            `miosa checkpoints list ${computerId}`,
          ]),
        );
        console.log();
      }),
    );

  // ── delete ─────────────────────────────────────────────────────────────────
  checkpoints
    .command("delete <computer-id> <checkpoint-id>")
    .description("Delete a checkpoint")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(async () => {
        await client().apiDelete<unknown>(
          apiPath(
            `/computers/${enc(computerId)}/snapshots/${enc(checkpointId)}`,
          ),
        );

        if (opts.json) {
          console.log(
            JSON.stringify({ deleted: true, id: checkpointId }, null, 2),
          );
          return;
        }

        console.log();
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "Deleted",
              value: chalk.bold(checkpointId),
            },
            { label: "Computer", value: chalk.dim(computerId) },
          ]),
        );
        console.log();
        console.log(hintBlock("Try", [`miosa checkpoints list ${computerId}`]));
        console.log();
      }),
    );
}
