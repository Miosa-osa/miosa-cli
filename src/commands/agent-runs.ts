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
import { isJsonMode } from "../cli-env.js";
import { renderTable } from "../ui/table.js";

interface AgentRun {
  id: string;
  target_kind?: string;
  target_id?: string;
  provider?: string;
  status?: string;
  prompt?: string;
  created_at?: string;
  updated_at?: string;
}

interface AgentArtifact {
  id: string;
  path?: string;
  kind?: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
}

function rows(raw: unknown): AgentRun[] {
  if (Array.isArray(raw)) return raw as AgentRun[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "runs", "items"]) {
      if (Array.isArray(value[key])) return value[key] as AgentRun[];
    }
  }
  return [];
}

function artifactRows(raw: unknown): AgentArtifact[] {
  if (Array.isArray(raw)) return raw as AgentArtifact[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "artifacts", "items"]) {
      if (Array.isArray(value[key])) return value[key] as AgentArtifact[];
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

export function register(program: Command): void {
  const command = program
    .command("agent-runs")
    .description("List, inspect, and cancel Agent Runs");

  command
    .command("list")
    .description("List Agent Runs")
    .option("--sandbox <id>", "Filter by sandbox ID")
    .option("--computer <id>", "Filter by computer ID")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
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
            unwrap(await client().apiGet<unknown>(`/api/v1/agent-runs${suffix}`)),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          if (data.length === 0) {
            console.log(chalk.dim("No agent runs found."));
            return;
          }
          renderTable(data, [
            { header: "ID", key: "id", width: 18 },
            { header: "TARGET", key: (row) => `${str(row.target_kind)} ${str(row.target_id)}`, width: 28 },
            { header: "PROVIDER", key: "provider", width: 12 },
            { header: "STATUS", key: (row) => colorStatus(row.status), width: 12 },
            { header: "PROMPT", key: (row) => str(row.prompt), width: 44 },
          ]);
        }),
    );

  command
    .command("show <id>")
    .description("Show one Agent Run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/agent-runs/${enc(id)}`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("artifacts <id>")
    .description("List artifacts declared by an Agent Run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = artifactRows(
          unwrap(
            await client().apiGet<unknown>(
              `/api/v1/agent-runs/${enc(id)}/artifacts`,
            ),
          ),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.length === 0) {
          console.log(chalk.dim("No artifacts found."));
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
    .command("download <id> <artifact-id>")
    .description("Download an Agent Run artifact to a local file or stdout")
    .option("--output <file>", "Write to this local file instead of stdout")
    .option("--inline", "Ask the API for inline disposition metadata")
    .option("--json", "Output as JSON metadata")
    .action(
      (
        id: string,
        artifactId: string,
        opts: { output?: string; inline?: boolean } & JsonOptions,
      ) =>
        runAction(async () => {
          const query = new URLSearchParams();
          if (opts.inline) query.set("disposition", "inline");
          const suffix = query.toString() ? `?${query.toString()}` : "";
          const bytes = await client().apiGetBinary(
            apiPath(
              `/agent-runs/${enc(id)}/artifacts/${enc(artifactId)}/download${suffix}`,
            ),
          );

          if (opts.output) {
            fs.writeFileSync(opts.output, bytes);
            if (isJsonMode(opts)) {
              console.log(
                JSON.stringify(
                  {
                    agent_run_id: id,
                    artifact_id: artifactId,
                    output: opts.output,
                    bytes: bytes.length,
                  },
                  null,
                  2,
                ),
              );
              return;
            }
            console.log(chalk.green(`Downloaded artifact ${artifactId} → ${opts.output}`));
            return;
          }

          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                {
                  agent_run_id: id,
                  artifact_id: artifactId,
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
    .description("Cancel an Agent Run")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiPost<unknown>(
            `/api/v1/agent-runs/${enc(id)}/cancel`,
            {},
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(chalk.green(`Canceled agent run ${id}`));
      }),
    );
}
