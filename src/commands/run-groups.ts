import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
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

interface RunGroup {
  id: string;
  name?: string;
  status?: string;
  concurrency_limit?: number;
  expected_runs?: number;
  counts?: Record<string, number>;
  created_at?: string;
}

interface RunGroupActivity {
  id?: string;
  run_group_id?: string;
  run_id?: string;
  sequence?: number;
  type?: string;
  message?: string;
  created_at?: string;
}

interface RunFile {
  id: string;
  run_id?: string;
  path?: string;
  kind?: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
}

function rows(raw: unknown): RunGroup[] {
  if (Array.isArray(raw)) return raw as RunGroup[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "groups", "items"]) {
      if (Array.isArray(value[key])) return value[key] as RunGroup[];
    }
  }
  return [];
}

function activityRows(raw: unknown): RunGroupActivity[] {
  if (Array.isArray(raw)) return raw as RunGroupActivity[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "activity", "items"]) {
      if (Array.isArray(value[key])) return value[key] as RunGroupActivity[];
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

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function colorStatus(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "running":
      return chalk.green(status);
    case "succeeded":
      return chalk.dim(status);
    case "failed":
    case "canceled":
      return chalk.red(status);
    default:
      return chalk.dim(status ?? "-");
  }
}

function groupActivityData(event: unknown): RunGroupActivity {
  if (!event || typeof event !== "object") return {};
  const value = event as Record<string, unknown>;

  if (value["type"] === "unknown" && typeof value["raw"] === "string") {
    try {
      return JSON.parse(value["raw"]) as RunGroupActivity;
    } catch {
      return { type: "unknown", message: value["raw"] };
    }
  }

  if (value["data"] && typeof value["data"] === "object") {
    return value["data"] as RunGroupActivity;
  }

  return value as RunGroupActivity;
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

async function waitForGroup(
  id: string,
  timeoutSec: number,
  includeRuns: boolean,
): Promise<RunGroup> {
  const deadline = Date.now() + timeoutSec * 1000;
  const suffix = includeRuns ? "?include=runs" : "";

  while (true) {
    const data = unwrap(
      await client().apiGet<unknown>(
        `/api/v1/run-groups/${enc(id)}${suffix}`,
      ),
    ) as RunGroup;
    if (isTerminalStatus(data.status)) return data;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for run group ${id}`);
    }
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

async function groupFiles(id: string): Promise<RunFile[]> {
  const group = unwrap(
    await client().apiGet<unknown>(
      `/api/v1/run-groups/${enc(id)}?include=runs`,
    ),
  ) as Record<string, unknown>;
  const runs = Array.isArray(group["runs"]) ? group["runs"] : [];
  const files: RunFile[] = [];

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const runId = str((run as Record<string, unknown>)["id"]);
    if (!runId) continue;

    const rows = fileRows(
      unwrap(
        await client().apiGet<unknown>(
          `/api/v1/runs/${enc(runId)}/files`,
        ),
      ),
    );

    files.push(
      ...rows.map((file) => ({
        ...file,
        run_id: file.run_id ?? runId,
      })),
    );
  }

  return files;
}

function localFilePath(downloadDir: string, file: RunFile): string {
  const runId = str(file.run_id || "run");
  const rawPath = str(file.path || file.id || "file");
  const normalized = path.normalize(rawPath.replace(/^\/+/, ""));
  const relativePath =
    normalized.startsWith("..") || path.isAbsolute(normalized)
      ? str(file.id || "file")
      : normalized;

  return path.join(downloadDir, runId, relativePath);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function manifestFromOptions(opts: { manifest?: string; run?: string[] }): unknown[] {
  if (opts.manifest) {
    const parsed = parseJsonFile(opts.manifest);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown[] }).runs)) {
      return (parsed as { runs: unknown[] }).runs;
    }
    throw new Error("Manifest must be a JSON array or an object with a runs array.");
  }
  if (opts.run?.length) {
    return opts.run.map((value) => JSON.parse(value));
  }
  return [];
}

export function register(program: Command): void {
  const command = program
    .command("run-groups")
    .description("Create and operate run groups");

  command
    .command("create")
    .description("Create a run group")
    .requiredOption("--name <name>", "Group name")
    .option("--description <text>", "Group description")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--concurrency <n>", "Concurrency limit")
    .option("--expected-runs <n>", "Expected run count")
    .option("--metadata <json>", "Metadata JSON object")
    .option("--json", "Output as JSON")
    .action(
      (
        opts: {
          name: string;
          description?: string;
          workspace?: string;
          project?: string;
          concurrency?: string;
          expectedRuns?: string;
          metadata?: string;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          const body: Record<string, unknown> = {
            name: opts.name,
            description: opts.description,
            workspace_id: opts.workspace,
            project_id: opts.project,
            concurrency_limit: opts.concurrency ? Number(opts.concurrency) : undefined,
            expected_runs: opts.expectedRuns ? Number(opts.expectedRuns) : undefined,
            metadata: opts.metadata ? JSON.parse(opts.metadata) : undefined,
          };

          Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
          const data = unwrap(await client().apiPost<unknown>("/api/v1/run-groups", body));

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(chalk.green(`Created run group ${str((data as RunGroup).id)}`));
        }),
    );

  command
    .command("list")
    .description("List run groups")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Maximum groups to return")
    .option("--json", "Output as JSON")
    .action(
      (
        opts: {
          workspace?: string;
          project?: string;
          status?: string;
          limit?: string;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          const query = new URLSearchParams();
          if (opts.workspace) query.set("workspace_id", opts.workspace);
          if (opts.project) query.set("project_id", opts.project);
          if (opts.status) query.set("status", opts.status);
          if (opts.limit) query.set("limit", opts.limit);

          const suffix = query.toString() ? `?${query.toString()}` : "";
          const data = rows(
            unwrap(await client().apiGet<unknown>(`/api/v1/run-groups${suffix}`)),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          if (data.length === 0) {
            console.log(chalk.dim("No run groups found."));
            return;
          }
          renderTable(data, [
            { header: "ID", key: "id", width: 18 },
            { header: "NAME", key: "name", width: 28 },
            { header: "STATUS", key: (row) => colorStatus(row.status), width: 12 },
            { header: "RUNS", key: (row) => str(row.counts?.total ?? 0), width: 8 },
            { header: "EXPECTED", key: (row) => str(row.expected_runs ?? "-"), width: 10 },
          ]);
        }),
    );

  command
    .command("show <id>")
    .description("Show one run group")
    .option("--runs", "Include child runs")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { runs?: boolean } & JsonOptions) =>
      runAction(async () => {
        const suffix = opts.runs ? "?include=runs" : "";
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/run-groups/${enc(id)}${suffix}`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("dispatch <id>")
    .description("Dispatch a manifest of runs into a group")
    .option("--manifest <file>", "JSON array or { runs: [...] } file")
    .option("--run <json>", "One run JSON object; repeat for multiple runs", collect, [])
    .option("--async", "Queue entries and return immediately")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { manifest?: string; run?: string[]; async?: boolean } & JsonOptions) =>
      runAction(async () => {
        const runs = manifestFromOptions(opts);
        const data = unwrap(
          await client().apiPost<unknown>(`/api/v1/run-groups/${enc(id)}/dispatch`, {
            runs,
            async: opts.async || undefined,
          }),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("cancel <id>")
    .description("Cancel a run group and running children")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiPost<unknown>(`/api/v1/run-groups/${enc(id)}/cancel`, {}),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(chalk.green(`Canceled run group ${id}`));
      }),
    );

  command
    .command("files <id>")
    .description("List or download files from every child run in a group")
    .option("--download-dir <dir>", "Download all files into this directory")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { downloadDir?: string } & JsonOptions) =>
      runAction(async () => {
        const files = await groupFiles(id);

        if (opts.downloadDir) {
          const downloaded: Array<RunFile & { output: string; bytes: number }> = [];
          for (const file of files) {
            if (!file.id || !file.run_id) continue;
            const output = localFilePath(opts.downloadDir, file);
            fs.mkdirSync(path.dirname(output), { recursive: true });
            const bytes = await client().apiGetBinary(
              apiPath(
                `/runs/${enc(file.run_id)}/files/${enc(
                  file.id,
                )}/download`,
              ),
            );
            fs.writeFileSync(output, bytes);
            downloaded.push({ ...file, output, bytes: bytes.length });
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(downloaded, null, 2));
            return;
          }
          console.log(
            chalk.green(
              `Downloaded ${downloaded.length} file${downloaded.length === 1 ? "" : "s"} to ${opts.downloadDir}`,
            ),
          );
          return;
        }

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(files, null, 2));
          return;
        }
        if (files.length === 0) {
          console.log(chalk.dim("No run group files found."));
          return;
        }
        renderTable(files, [
          { header: "RUN", key: (row) => str(row.run_id ?? "-"), width: 18 },
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
    .description("Show or stream run group activity")
    .option("--stream", "Keep the connection open and stream new activity")
    .option("--limit <n>", "Stop after N streamed activity entries")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { stream?: boolean; limit?: string } & JsonOptions) =>
      runAction(async () => {
        const path = `/api/v1/run-groups/${enc(id)}/activity`;

        if (opts.stream) {
          const limit = opts.limit ? Number(opts.limit) : undefined;
          let seen = 0;
          const res = await client().apiStream(path);

          for await (const event of parseSse(res.body)) {
            seen += 1;
            const data = groupActivityData(event);

            if (isJsonMode(opts)) {
              console.log(JSON.stringify(data, null, 2));
            } else {
              console.log(
                [
                  chalk.dim(str(data.sequence ?? seen)),
                  colorStatus(data.type),
                  str(data.run_id),
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

        const data = activityRows(unwrap(await client().apiGet<unknown>(path)));
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.length === 0) {
          console.log(chalk.dim("No run group activity found."));
          return;
        }
        renderTable(data, [
          { header: "SEQ", key: (row) => str(row.sequence ?? "-"), width: 8 },
          { header: "TYPE", key: (row) => colorStatus(row.type), width: 18 },
          { header: "RUN", key: (row) => str(row.run_id ?? "-"), width: 18 },
          { header: "MESSAGE", key: (row) => str(row.message ?? ""), width: 42 },
        ]);
      }),
    );

  command
    .command("wait <id>")
    .description("Wait for a run group to reach a terminal state")
    .option("--runs", "Include child runs in the final response")
    .option("--timeout <seconds>", "Maximum seconds to wait", "900")
    .option("--json", "Output as JSON")
    .action(
      (id: string, opts: { runs?: boolean; timeout?: string } & JsonOptions) =>
        runAction(async () => {
          const data = await waitForGroup(
            id,
            Number(opts.timeout ?? 900),
            Boolean(opts.runs),
          );
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(
            `${chalk.green("Run group finished")} ${id} ${colorStatus(data.status)}`,
          );
        }),
    );
}

function collect(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}
