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

interface AgentRunGroup {
  id: string;
  name?: string;
  status?: string;
  concurrency_limit?: number;
  expected_runs?: number;
  counts?: Record<string, number>;
  created_at?: string;
}

interface AgentRunGroupEvent {
  id?: string;
  agent_run_group_id?: string;
  agent_run_id?: string;
  sequence?: number;
  type?: string;
  message?: string;
  created_at?: string;
}

interface AgentArtifact {
  id: string;
  agent_run_id?: string;
  path?: string;
  kind?: string;
  mime_type?: string;
  size_bytes?: number;
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

function eventRows(raw: unknown): AgentRunGroupEvent[] {
  if (Array.isArray(raw)) return raw as AgentRunGroupEvent[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "events", "items"]) {
      if (Array.isArray(value[key])) return value[key] as AgentRunGroupEvent[];
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

function groupEventData(event: unknown): AgentRunGroupEvent {
  if (!event || typeof event !== "object") return {};
  const value = event as Record<string, unknown>;

  if (value["type"] === "unknown" && typeof value["raw"] === "string") {
    try {
      return JSON.parse(value["raw"]) as AgentRunGroupEvent;
    } catch {
      return { type: "unknown", message: value["raw"] };
    }
  }

  if (value["data"] && typeof value["data"] === "object") {
    return value["data"] as AgentRunGroupEvent;
  }

  return value as AgentRunGroupEvent;
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
): Promise<AgentRunGroup> {
  const deadline = Date.now() + timeoutSec * 1000;
  const suffix = includeRuns ? "?include=runs" : "";

  while (true) {
    const data = unwrap(
      await client().apiGet<unknown>(
        `/api/v1/agent-run-groups/${enc(id)}${suffix}`,
      ),
    ) as AgentRunGroup;
    if (isTerminalStatus(data.status)) return data;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for agent run group ${id}`);
    }
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

async function groupArtifacts(id: string): Promise<AgentArtifact[]> {
  const group = unwrap(
    await client().apiGet<unknown>(
      `/api/v1/agent-run-groups/${enc(id)}?include=runs`,
    ),
  ) as Record<string, unknown>;
  const runs = Array.isArray(group["runs"]) ? group["runs"] : [];
  const artifacts: AgentArtifact[] = [];

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const runId = str((run as Record<string, unknown>)["id"]);
    if (!runId) continue;

    const rows = artifactRows(
      unwrap(
        await client().apiGet<unknown>(
          `/api/v1/agent-runs/${enc(runId)}/artifacts`,
        ),
      ),
    );

    artifacts.push(
      ...rows.map((artifact) => ({
        ...artifact,
        agent_run_id: artifact.agent_run_id ?? runId,
      })),
    );
  }

  return artifacts;
}

function localArtifactPath(downloadDir: string, artifact: AgentArtifact): string {
  const runId = str(artifact.agent_run_id || "run");
  const rawPath = str(artifact.path || artifact.id || "artifact");
  const normalized = path.normalize(rawPath.replace(/^\/+/, ""));
  const relativePath =
    normalized.startsWith("..") || path.isAbsolute(normalized)
      ? str(artifact.id || "artifact")
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
    .option("--async", "Queue entries and return immediately")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { manifest?: string; run?: string[]; async?: boolean } & JsonOptions) =>
      runAction(async () => {
        const runs = manifestFromOptions(opts);
        const data = unwrap(
          await client().apiPost<unknown>(`/api/v1/agent-run-groups/${enc(id)}/dispatch`, {
            runs,
            async: opts.async || undefined,
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

  command
    .command("artifacts <id>")
    .description("List or download artifacts from every child Agent Run in a group")
    .option("--download-dir <dir>", "Download all artifacts into this directory")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { downloadDir?: string } & JsonOptions) =>
      runAction(async () => {
        const artifacts = await groupArtifacts(id);

        if (opts.downloadDir) {
          const downloaded: Array<AgentArtifact & { output: string; bytes: number }> = [];
          for (const artifact of artifacts) {
            if (!artifact.id || !artifact.agent_run_id) continue;
            const output = localArtifactPath(opts.downloadDir, artifact);
            fs.mkdirSync(path.dirname(output), { recursive: true });
            const bytes = await client().apiGetBinary(
              apiPath(
                `/agent-runs/${enc(artifact.agent_run_id)}/artifacts/${enc(
                  artifact.id,
                )}/download`,
              ),
            );
            fs.writeFileSync(output, bytes);
            downloaded.push({ ...artifact, output, bytes: bytes.length });
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(downloaded, null, 2));
            return;
          }
          console.log(
            chalk.green(
              `Downloaded ${downloaded.length} artifact${downloaded.length === 1 ? "" : "s"} to ${opts.downloadDir}`,
            ),
          );
          return;
        }

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(artifacts, null, 2));
          return;
        }
        if (artifacts.length === 0) {
          console.log(chalk.dim("No agent run group artifacts found."));
          return;
        }
        renderTable(artifacts, [
          { header: "RUN", key: (row) => str(row.agent_run_id ?? "-"), width: 18 },
          { header: "ID", key: "id", width: 18 },
          { header: "KIND", key: "kind", width: 10 },
          { header: "MIME", key: "mime_type", width: 24 },
          { header: "SIZE", key: (row) => str(row.size_bytes ?? "-"), width: 10 },
          { header: "PATH", key: (row) => str(row.path), width: 56 },
        ]);
      }),
    );

  command
    .command("events <id>")
    .description("Show or stream Agent Run Group events")
    .option("--stream", "Keep the connection open and stream new events")
    .option("--limit <n>", "Stop after N streamed events")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { stream?: boolean; limit?: string } & JsonOptions) =>
      runAction(async () => {
        const path = `/api/v1/agent-run-groups/${enc(id)}/events`;

        if (opts.stream) {
          const limit = opts.limit ? Number(opts.limit) : undefined;
          let seen = 0;
          const res = await client().apiStream(path);

          for await (const event of parseSse(res.body)) {
            seen += 1;
            const data = groupEventData(event);

            if (isJsonMode(opts)) {
              console.log(JSON.stringify(data, null, 2));
            } else {
              console.log(
                [
                  chalk.dim(str(data.sequence ?? seen)),
                  colorStatus(data.type),
                  str(data.agent_run_id),
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
          console.log(chalk.dim("No agent run group events found."));
          return;
        }
        renderTable(data, [
          { header: "SEQ", key: (row) => str(row.sequence ?? "-"), width: 8 },
          { header: "TYPE", key: (row) => colorStatus(row.type), width: 18 },
          { header: "RUN", key: (row) => str(row.agent_run_id ?? "-"), width: 18 },
          { header: "MESSAGE", key: (row) => str(row.message ?? ""), width: 42 },
        ]);
      }),
    );

  command
    .command("wait <id>")
    .description("Wait for an Agent Run Group to reach a terminal state")
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
            `${chalk.green("Agent run group finished")} ${id} ${colorStatus(data.status)}`,
          );
        }),
    );
}

function collect(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}
