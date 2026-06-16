import type { Command } from "commander";
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

interface AgentRuntimeProfile {
  id: string;
  name: string;
  runtime: string;
  workspace_id?: string | null;
  project_id?: string | null;
  is_default?: boolean;
  tools?: string[];
  connectors?: string[];
}

function rows(raw: unknown): AgentRuntimeProfile[] {
  if (Array.isArray(raw)) return raw as AgentRuntimeProfile[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    for (const key of ["data", "items", "profiles"]) {
      if (Array.isArray(value[key])) return value[key] as AgentRuntimeProfile[];
    }
  }
  return [];
}

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function mergeLists(...values: Array<string[] | undefined>): string[] | undefined {
  const merged = values.flatMap((value) => value ?? []);
  return merged.length > 0 ? Array.from(new Set(merged)) : undefined;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseEnvPairs(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      throw new Error(`Invalid --env-var ${value}; expected KEY=VALUE`);
    }
    env[value.slice(0, index)] = value.slice(index + 1);
  }
  return env;
}

function parseJsonObject(value: string | undefined, field: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mergeObjects(
  ...values: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function body(opts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(opts).filter(([, value]) => value !== undefined),
  );
}

export function register(program: Command): void {
  const command = program
    .command("agent-runtime-profiles")
    .alias("agent-profiles")
    .description("Manage tenant/workspace defaults for agents inside sandboxes and computers");

  command
    .command("list")
    .description("List agent runtime profiles")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action((opts: { workspace?: string; project?: string } & JsonOptions) =>
      runAction(async () => {
        const params = new URLSearchParams();
        if (opts.workspace) params.set("workspace_id", opts.workspace);
        if (opts.project) params.set("project_id", opts.project);
        const query = params.toString() ? `?${params.toString()}` : "";
        const data = rows(unwrap(await client().apiGet<unknown>(`/api/v1/agent-runtime-profiles${query}`)));
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.length === 0) {
          console.log(chalk.dim("No agent runtime profiles found."));
          return;
        }
        renderTable(data, [
          { header: "ID", key: "id", width: 14 },
          { header: "NAME", key: "name", width: 28 },
          { header: "RUNTIME", key: "runtime", width: 14 },
          { header: "WORKSPACE", key: "workspace_id", width: 18 },
          { header: "PROJECT", key: "project_id", width: 18 },
          {
            header: "DEFAULT",
            key: (row) => (row.is_default ? "yes" : "no"),
            width: 8,
          },
        ]);
      }),
    );

  command
    .command("show <id>")
    .description("Show one agent runtime profile")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(
          await client().apiGet<unknown>(`/api/v1/agent-runtime-profiles/${enc(id)}`),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("create")
    .description("Create an agent runtime profile")
    .requiredOption("--name <name>", "Profile name")
    .requiredOption("--runtime <runtime>", "osa, codex, claude-code, pi, hermes, or custom")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--description <text>", "Profile description")
    .option("--applies-to <csv>", "Comma-separated resource kinds: sandbox, computer, agent")
    .option("--tools <csv>", "Comma-separated tool IDs")
    .option("--tool <id>", "Tool ID. Repeatable.", collectOption, [])
    .option("--connectors <csv>", "Comma-separated connector UIDs")
    .option("--connector <uid>", "Connector UID. Repeatable.", collectOption, [])
    .option("--env <json>", "Environment defaults as a JSON object")
    .option("--env-var <KEY=VALUE>", "Environment default. Repeatable.", collectOption, [])
    .option("--policy <json>", "Policy defaults as a JSON object")
    .option("--metadata <json>", "Metadata as a JSON object")
    .option("--default", "Mark as default")
    .option("--json", "Output as JSON")
    .action((opts: Record<string, string | boolean | undefined> & JsonOptions) =>
      runAction(async () => {
        const payload = body({
          name: opts.name,
          runtime: opts.runtime,
          workspace_id: opts.workspace,
          project_id: opts.project,
          description: opts.description,
          applies_to: splitList(opts.appliesTo as string | undefined),
          tools: mergeLists(
            splitList(opts.tools as string | undefined),
            opts.tool as string[] | undefined,
          ),
          connectors: mergeLists(
            splitList(opts.connectors as string | undefined),
            opts.connector as string[] | undefined,
          ),
          env: mergeObjects(
            parseJsonObject(opts.env as string | undefined, "--env"),
            parseEnvPairs(opts.envVar as string[] | undefined),
          ),
          policy: parseJsonObject(opts.policy as string | undefined, "--policy"),
          metadata: parseJsonObject(opts.metadata as string | undefined, "--metadata"),
          is_default: opts.default === true,
        });
        const data = unwrap(
          await client().apiPost<unknown>("/api/v1/agent-runtime-profiles", payload),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("update <id>")
    .description("Update an agent runtime profile")
    .option("--name <name>", "Profile name")
    .option("--runtime <runtime>", "osa, codex, claude-code, pi, hermes, or custom")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--description <text>", "Profile description")
    .option("--applies-to <csv>", "Comma-separated resource kinds: sandbox, computer, agent")
    .option("--tools <csv>", "Comma-separated tool IDs")
    .option("--tool <id>", "Tool ID. Repeatable.", collectOption, [])
    .option("--connectors <csv>", "Comma-separated connector UIDs")
    .option("--connector <uid>", "Connector UID. Repeatable.", collectOption, [])
    .option("--env <json>", "Environment defaults as a JSON object")
    .option("--env-var <KEY=VALUE>", "Environment default. Repeatable.", collectOption, [])
    .option("--policy <json>", "Policy defaults as a JSON object")
    .option("--metadata <json>", "Metadata as a JSON object")
    .option("--default", "Mark as default")
    .option("--json", "Output as JSON")
    .action((id: string, opts: Record<string, string | boolean | undefined> & JsonOptions) =>
      runAction(async () => {
        const payload = body({
          name: opts.name,
          runtime: opts.runtime,
          workspace_id: opts.workspace,
          project_id: opts.project,
          description: opts.description,
          applies_to: splitList(opts.appliesTo as string | undefined),
          tools: mergeLists(
            splitList(opts.tools as string | undefined),
            opts.tool as string[] | undefined,
          ),
          connectors: mergeLists(
            splitList(opts.connectors as string | undefined),
            opts.connector as string[] | undefined,
          ),
          env: mergeObjects(
            parseJsonObject(opts.env as string | undefined, "--env"),
            parseEnvPairs(opts.envVar as string[] | undefined),
          ),
          policy: parseJsonObject(opts.policy as string | undefined, "--policy"),
          metadata: parseJsonObject(opts.metadata as string | undefined, "--metadata"),
          is_default: opts.default === true ? true : undefined,
        });
        const data = unwrap(
          await client().apiPut<unknown>(`/api/v1/agent-runtime-profiles/${enc(id)}`, payload),
        );
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("delete <id>")
    .description("Delete an agent runtime profile")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        await client().apiDelete<unknown>(`/api/v1/agent-runtime-profiles/${enc(id)}`);
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ ok: true, id }, null, 2));
          return;
        }
        console.log(chalk.green(`Deleted agent runtime profile ${id}`));
      }),
    );
}
