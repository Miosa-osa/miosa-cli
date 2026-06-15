import type { Command } from "commander";
import chalk from "chalk";
import { isJsonMode } from "../cli-env.js";
import { renderTable } from "../ui/table.js";
import {
  client,
  enc,
  runAction,
  unwrap,
  type JsonOptions,
} from "./enterprise-util.js";
import { parseEnvPairs } from "./util.js";

interface RuntimeEnvVar {
  id: string;
  scope: string;
  workspace_id?: string | null;
  project_id?: string | null;
  target: string;
  name: string;
  preview?: string;
  enabled?: boolean;
  updated_at?: string;
}

interface ScopeOptions extends JsonOptions {
  scope?: string;
  workspace?: string;
  project?: string;
  target?: string;
}

function rows(raw: unknown): RuntimeEnvVar[] {
  if (Array.isArray(raw)) return raw as RuntimeEnvVar[];
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    if (Array.isArray(value.data)) return value.data as RuntimeEnvVar[];
  }
  return [];
}

function query(opts: ScopeOptions): string {
  const params = new URLSearchParams();
  if (opts.scope) params.set("scope", opts.scope);
  if (opts.workspace) params.set("workspace_id", opts.workspace);
  if (opts.project) params.set("project_id", opts.project);
  if (opts.target) params.set("target", opts.target);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function printRows(data: RuntimeEnvVar[], opts: JsonOptions): void {
  if (isJsonMode(opts)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.length === 0) {
    console.log(chalk.dim("No inherited runtime env vars found."));
    return;
  }
  renderTable(data, [
    { header: "ID", key: "id", width: 14 },
    { header: "NAME", key: "name", width: 28 },
    { header: "SCOPE", key: "scope", width: 12 },
    { header: "TARGET", key: "target", width: 10 },
    { header: "VALUE", key: (row) => chalk.dim(row.preview ?? "***"), width: 18 },
    { header: "WORKSPACE", key: "workspace_id", width: 18 },
    { header: "PROJECT", key: "project_id", width: 18 },
  ]);
}

function payloadFor(
  opts: ScopeOptions,
  name: string,
  value: string,
): Record<string, unknown> {
  return {
    scope: opts.scope ?? "tenant",
    workspace_id: opts.workspace,
    project_id: opts.project,
    target: opts.target ?? "all",
    name,
    value,
  };
}

export function register(program: Command): void {
  const command = program
    .command("runtime-env")
    .alias("runtime-secrets")
    .description("Manage inherited tenant/workspace/project env for sandboxes, computers, and agents");

  command
    .command("list")
    .description("List inherited runtime env vars")
    .option("--scope <scope>", "tenant, workspace, or project")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--target <target>", "all, sandbox, computer, agent, or deployment")
    .option("--json", "Output as JSON")
    .action((opts: ScopeOptions) =>
      runAction(async () => {
        const data = rows(unwrap(await client().apiGet<unknown>(`/api/v1/runtime-env${query(opts)}`)));
        printRows(data, opts);
      }),
    );

  command
    .command("set <pairs...>")
    .description("Set inherited runtime env vars as KEY=VALUE")
    .option("--scope <scope>", "tenant, workspace, or project", "tenant")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--target <target>", "all, sandbox, computer, agent, or deployment", "all")
    .option("--json", "Output as JSON")
    .action((pairs: string[], opts: ScopeOptions) =>
      runAction(async () => {
        const values = parseEnvPairs(pairs);
        const results: RuntimeEnvVar[] = [];
        for (const [name, value] of Object.entries(values)) {
          results.push(
            unwrap(
              await client().apiPost<unknown>(
                "/api/v1/runtime-env",
                payloadFor(opts, name, value),
              ),
            ) as RuntimeEnvVar,
          );
        }
        printRows(results, opts);
      }),
    );

  command
    .command("show <id>")
    .description("Show one inherited runtime env var")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const data = unwrap(await client().apiGet<unknown>(`/api/v1/runtime-env/${enc(id)}`));
        console.log(JSON.stringify(data, null, 2));
      }),
    );

  command
    .command("unset <ids...>")
    .description("Delete inherited runtime env vars by ID")
    .option("--json", "Output as JSON")
    .action((ids: string[], opts: JsonOptions) =>
      runAction(async () => {
        for (const id of ids) {
          await client().apiDelete<unknown>(`/api/v1/runtime-env/${enc(id)}`);
        }
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ ok: true, deleted: ids.length }, null, 2));
          return;
        }
        console.log(chalk.green(`Deleted ${ids.length} runtime env var(s).`));
      }),
    );
}
