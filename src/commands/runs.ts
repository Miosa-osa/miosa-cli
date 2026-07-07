import type { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import {
  apiPath,
  client,
  enc,
  runAction,
  unwrap,
  type JsonOptions,
} from "./enterprise-util.js";
import { parseSse } from "../client.js";
import { isJsonMode } from "../cli-env.js";
import { renderTable } from "../ui/table.js";

interface Run {
  id: string;
  target_kind?: string;
  target_id?: string;
  external_workspace_id?: string;
  external_user_id?: string;
  external_project_id?: string;
  runner?: string;
  status?: string;
  instruction?: string;
  created_at?: string;
  updated_at?: string;
}

interface RunFile {
  id: string;
  path?: string;
  name?: string;
  kind?: string;
  mime_type?: string;
  size_bytes?: number;
  download_url?: string;
  created_at?: string;
}

interface RunActivity {
  id?: string;
  run_id?: string;
  sequence?: number;
  type?: string;
  message?: string;
  created_at?: string;
}

function rows(raw: unknown): Run[] {
  if (Array.isArray(raw)) return raw as Run[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "runs", "items"]) {
      if (Array.isArray(value[key])) return value[key] as Run[];
    }
  }
  return [];
}

function eventRows(raw: unknown): RunActivity[] {
  if (Array.isArray(raw)) return raw as RunActivity[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "activity", "items"]) {
      if (Array.isArray(value[key])) return value[key] as RunActivity[];
    }
  }
  return [];
}

function fileRows(raw: unknown): RunFile[] {
  if (Array.isArray(raw)) return raw as RunFile[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "files", "items"]) {
      if (Array.isArray(value[key])) return value[key] as RunFile[];
    }
  }
  return [];
}

function colorStatus(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "running":
      return chalk.green(status);
    case "succeeded":
      return chalk.dim(status);
    case "failed":
    case "canceled":
    case "cancelled":
      return chalk.red(status);
    default:
      return chalk.dim(status ?? "-");
  }
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function activityData(event: unknown): RunActivity {
  if (!event || typeof event !== "object") return {};
  const value = event as Record<string, unknown>;

  if (value["type"] === "unknown" && typeof value["raw"] === "string") {
    try {
      return JSON.parse(value["raw"]) as RunActivity;
    } catch {
      return { type: "unknown", message: value["raw"] };
    }
  }

  if (value["data"] && typeof value["data"] === "object") {
    return value["data"] as RunActivity;
  }

  return value as RunActivity;
}

function isTerminalStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    ["succeeded", "failed", "canceled", "cancelled"].includes(status.toLowerCase())
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRun(id: string, timeoutSec: number): Promise<Run> {
  const deadline = Date.now() + timeoutSec * 1000;

  while (true) {
    const data = unwrap(
      await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}`),
    ) as Run;
    if (isTerminalStatus(data.status)) return data;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for run ${id}`);
    }
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

export function register(program: Command): void {
  const command = program
    .command("runs")
    .description("List, inspect, and cancel runs");

  command
    .command("list")
    .description("List runs")
    .option("--sandbox <id>", "Filter by sandbox ID")
    .option("--computer <id>", "Filter by computer ID")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--external-workspace <id>", "Filter by white-label workspace/customer ID")
    .option("--external-user <id>", "Filter by white-label user ID")
    .option("--external-project <id>", "Filter by white-label project ID")
    .option("--target-kind <kind>", "Filter by target kind")
    .option("--target-id <id>", "Filter by target ID")
    .option("--status <status>", "Filter by run status")
    .option("--limit <n>", "Maximum runs to return")
    .option("--json", "Output as JSON")
    .action(
      (
        opts: {
          sandbox?: string;
          computer?: string;
          workspace?: string;
          project?: string;
          externalWorkspace?: string;
          externalUser?: string;
          externalProject?: string;
          targetKind?: string;
          targetId?: string;
          status?: string;
          limit?: string;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          if ((opts.sandbox || opts.computer) && (opts.targetKind || opts.targetId)) {
            throw new Error("Use either --sandbox/--computer or --target-kind/--target-id, not both.");
          }
          if (opts.sandbox && opts.computer) {
            throw new Error("Use only one of --sandbox or --computer.");
          }
          const query = new URLSearchParams();
          if (opts.workspace) query.set("workspace_id", opts.workspace);
          if (opts.project) query.set("project_id", opts.project);
          if (opts.externalWorkspace)
            query.set("external_workspace_id", opts.externalWorkspace);
          if (opts.externalUser) query.set("external_user_id", opts.externalUser);
          if (opts.externalProject)
            query.set("external_project_id", opts.externalProject);
          if (opts.sandbox) {
            query.set("target_kind", "sandbox");
            query.set("target_id", opts.sandbox);
          }
          if (opts.computer) {
            query.set("target_kind", "computer");
            query.set("target_id", opts.computer);
          }
          if (opts.targetKind) query.set("target_kind", opts.targetKind);
          if (opts.targetId) query.set("target_id", opts.targetId);
          if (opts.status) query.set("status", opts.status);
          if (opts.limit) query.set("limit", opts.limit);
          const suffix = query.toString() ? `?${query.toString()}` : "";
          const data = rows(
            unwrap(await client().apiGet<unknown>(`/api/v1/runs${suffix}`)),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          if (data.length === 0) {
            console.log(chalk.dim("No runs found."));
            return;
          }
          renderTable(data, [
            { header: "ID", key: "id", width: 18 },
            { header: "TARGET", key: (row) => `${str(row.target_kind)} ${str(row.target_id)}`, width: 28 },
            {
              header: "EXTERNAL",
              key: (row) =>
                [
                  str(row.external_workspace_id),
                  str(row.external_user_id),
                  str(row.external_project_id),
                ]
                  .filter(Boolean)
                  .join(" / "),
              width: 30,
            },
            { header: "RUNNER", key: "runner", width: 12 },
            { header: "STATUS", key: (row) => colorStatus(row.status), width: 12 },
            { header: "INSTRUCTION", key: (row) => str(row.instruction), width: 44 },
          ]);
        }),
    );

  command
    .command("show <id>")
    .description("Show one run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("outputs <id>")
    .description("Show all outputs for a run")
    .option("--json", "Output as JSON")
    .action((id: string, _opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}/outputs`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("files <id>")
    .description("List files produced by a run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = fileRows(
          unwrap(await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}/files`)),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.length === 0) {
          console.log(chalk.dim("No files found."));
          return;
        }
        renderTable(data, [
          { header: "ID", key: "id", width: 18 },
          { header: "KIND", key: "kind", width: 10 },
          { header: "MIME", key: "mime_type", width: 24 },
          { header: "SIZE", key: (row) => str(row.size_bytes ?? "-"), width: 10 },
          { header: "PATH", key: (row) => str(row.path), width: 56 },
        ]);
      }),
    );

  command
    .command("activity <id>")
    .description("Show or stream run activity")
    .option("--stream", "Keep the connection open and stream new events")
    .option("--limit <n>", "Stop after N streamed events")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { stream?: boolean; limit?: string } & JsonOptions) =>
      runAction(async () => {
        const path = `/api/v1/runs/${enc(id)}/activity`;

        if (opts.stream) {
          const limit = opts.limit ? Number(opts.limit) : undefined;
          let seen = 0;
          const res = await client().apiStream(path);

          for await (const event of parseSse(res.body)) {
            seen += 1;
            const data = activityData(event);

            if (isJsonMode(opts)) {
              console.log(JSON.stringify(data, null, 2));
            } else {
              console.log(
                [
                  chalk.dim(str(data.sequence ?? seen)),
                  colorStatus(data.type),
                  str(data.run_id ?? id),
                  str(data.message),
                ]
                  .filter(Boolean)
                  .join("  "),
              );
            }

            if (limit && seen >= limit) break;
          }
          return;
        }

        const data = eventRows(unwrap(await client().apiGet<unknown>(path)));
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.length === 0) {
          console.log(chalk.dim("No run activity found."));
          return;
        }
        renderTable(data, [
          { header: "SEQ", key: (row) => str(row.sequence ?? "-"), width: 8 },
          { header: "TYPE", key: (row) => colorStatus(row.type), width: 18 },
          { header: "MESSAGE", key: (row) => str(row.message ?? ""), width: 56 },
        ]);
      }),
    );

  command
    .command("messages <id>")
    .description("Show run messages")
    .option("--json", "Output as JSON")
    .action((id: string, _opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}/messages`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("command-output <id>")
    .description("Show run command output")
    .option("--json", "Output as JSON")
    .action((id: string, _opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(
            `/api/v1/runs/${enc(id)}/command-output`,
          ),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("previews <id>")
    .description("Show run previews")
    .option("--json", "Output as JSON")
    .action((id: string, _opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}/previews`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("diagnostics <id>")
    .description("Show run diagnostics")
    .option("--json", "Output as JSON")
    .action((id: string, _opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/runs/${enc(id)}/diagnostics`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("wait <id>")
    .description("Wait for a run to reach a terminal state")
    .option("--timeout <seconds>", "Maximum seconds to wait", "900")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { timeout?: string } & JsonOptions) =>
      runAction(async () => {
        const data = await waitForRun(id, Number(opts.timeout ?? 900));
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(
          `${chalk.green("Run finished")} ${id} ${colorStatus(data.status)}`,
        );
      }),
    );

  command
    .command("download-file <id> <file-id>")
    .description("Download a run file to a local file or stdout")
    .option("--output <file>", "Write to this local file instead of stdout")
    .option("--inline", "Ask the API for inline disposition metadata")
    .option("--json", "Output as JSON metadata")
    .action(
      (
        id: string,
        fileId: string,
        opts: { output?: string; inline?: boolean } & JsonOptions,
      ) =>
        runAction(async () => {
          const query = new URLSearchParams();
          if (opts.inline) query.set("disposition", "inline");
          const suffix = query.toString() ? `?${query.toString()}` : "";
          const bytes = await client().apiGetBinary(
            apiPath(`/runs/${enc(id)}/files/${enc(fileId)}/download${suffix}`),
          );

          if (opts.output) {
            fs.writeFileSync(opts.output, bytes);
            if (isJsonMode(opts)) {
              console.log(
                JSON.stringify(
                  {
                    run_id: id,
                    file_id: fileId,
                    output: opts.output,
                    bytes: bytes.length,
                  },
                  null,
                  2,
                ),
              );
              return;
            }
            console.log(chalk.green(`Downloaded file ${fileId} → ${opts.output}`));
            return;
          }

          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                {
                  run_id: id,
                  file_id: fileId,
                  bytes: bytes.length,
                  content_base64: bytes.toString("base64"),
                },
                null,
                2,
              ),
            );
            return;
          }

          process.stdout.write(bytes);
        }),
    );

  command
    .command("cancel <id>")
    .description("Cancel a run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiPost<unknown>(
            `/api/v1/runs/${enc(id)}/cancel`,
            {},
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(chalk.green(`Canceled run ${id}`));
      }),
    );
}
