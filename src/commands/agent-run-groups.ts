import type { Command } from "commander";
import fs from "node:fs";
import chalk from "chalk";
import {
  client,
  enc,
  runAction,
  unwrap,
  type JsonOptions,
} from "./enterprise-util.js";
import { isJsonMode } from "../cli-env.js";
import { renderTable } from "../ui/table.js";

interface AgentRunGroup {
  id: string;
  name?: string;
  status?: string;
  concurrency_limit?: number;
  expected_runs?: number;
  counts?: Record<string, number>;
  created_at?: string;
}

function rows(raw: unknown): AgentRunGroup[] {
  if (Array.isArray(raw)) return raw as AgentRunGroup[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "groups", "items"]) {
      if (Array.isArray(value[key])) return value[key] as AgentRunGroup[];
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
    .command("agent-run-groups")
    .description("Create and operate grouped multi-agent runs");

  command
    .command("create")
    .description("Create an Agent Run Group")
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
          const data = unwrap(await client().apiPost<unknown>("/api/v1/agent-run-groups", body));

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(chalk.green(`Created agent run group ${str((data as AgentRunGroup).id)}`));
        }),
    );

  command
    .command("list")
    .description("List Agent Run Groups")
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
            unwrap(await client().apiGet<unknown>(`/api/v1/agent-run-groups${suffix}`)),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          if (data.length === 0) {
            console.log(chalk.dim("No agent run groups found."));
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
    .description("Show one Agent Run Group")
    .option("--runs", "Include child runs")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { runs?: boolean } & JsonOptions) =>
      runAction(async () => {
        const suffix = opts.runs ? "?include=runs" : "";
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/agent-run-groups/${enc(id)}${suffix}`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("dispatch <id>")
    .description("Dispatch a manifest of Agent Runs into a group")
    .option("--manifest <file>", "JSON array or { runs: [...] } file")
    .option("--run <json>", "One run JSON object; repeat for multiple runs", collect, [])
    .option("--json", "Output as JSON")
    .action((id: string, opts: { manifest?: string; run?: string[] } & JsonOptions) =>
      runAction(async () => {
        const runs = manifestFromOptions(opts);
        const data = unwrap(
          await client().apiPost<unknown>(`/api/v1/agent-run-groups/${enc(id)}/dispatch`, {
            runs,
          }),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("cancel <id>")
    .description("Cancel an Agent Run Group and running children")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiPost<unknown>(`/api/v1/agent-run-groups/${enc(id)}/cancel`, {}),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(chalk.green(`Canceled agent run group ${id}`));
      }),
    );
}

function collect(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}
