import type { Command } from "commander";
import {
  addDataOption,
  apiPath,
  client,
  deleteAndPrint,
  enc,
  getAndPrint,
  patchAndPrint,
  printValue,
  postAndPrint,
  requireAction,
  runAction,
  unwrap,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

const actions = ["pull", "open-terminal", "run", "expose"] as const;

export function register(program: Command): void {
  const workspaces = program
    .command("workspaces")
    .alias("workspace")
    .description("Manage tenant workspaces and open-computer host workspaces");

  // ── Tenant workspace CRUD (/workspaces) ─────────────────────────────────

  workspaces
    .command("list")
    .description("List tenant workspaces")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/workspaces", opts)),
    );

  addDataOption(
    workspaces
      .command("create")
      .description("Create a tenant workspace")
      .option("--name <name>", "Workspace name")
      .option("--description <desc>", "Workspace description"),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        opts: DataOptions & {
          name?: string;
          description?: string;
        },
      ) =>
        runAction(async () => {
          const base: Record<string, unknown> = opts.data
            ? JSON.parse(opts.data)
            : {};
          if (opts.name) base["name"] = opts.name;
          if (opts.description) base["description"] = opts.description;
          await postAndPrint(
            "/workspaces",
            { ...opts, data: JSON.stringify(base) },
            {},
          );
        }),
    );

  workspaces
    .command("show <workspace-id>")
    .description("Show a tenant workspace")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/workspaces/${enc(id)}`, opts)),
    );

  addDataOption(
    workspaces
      .command("update <workspace-id>")
      .description("Update a tenant workspace"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => patchAndPrint(`/workspaces/${enc(id)}`, opts)),
    );

  workspaces
    .command("delete <workspace-id>")
    .description("Delete a tenant workspace")
    .option("--force", "Delete workspace resources in dependency order first")
    .option("--dry-run", "Return what would happen without deleting anything")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions & CleanupOptions) =>
      runAction(async () => {
        const query = queryString({
          force: opts.force,
          dry_run: opts.dryRun,
        });
        const value = await client().apiDelete<unknown>(
          apiPath(`/workspaces/${enc(id)}${query}`),
        );
        printValue(value, opts);
      }),
    );

  workspaces
    .command("inventory <workspace-id>")
    .description("Show every resource in a tenant workspace")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/workspaces/${enc(id)}/inventory`, opts)),
    );

  workspaces
    .command("cleanup <workspace-id>")
    .description("Cleanup workspace resources with filters, dry-run, and force")
    .option("--resource-type <type>", "Resource type or comma-separated types")
    .option("--state <state>", "Filter by resource state")
    .option("--name-prefix <prefix>", "Filter by resource name prefix")
    .option("--tag <tag>", "Filter sandboxes by tag key or key=value")
    .option("--older-than <duration>", "Filter by age, for example 2h or 30m")
    .option("--limit <n>", "Maximum resources per type")
    .option("--dry-run", "Return exact resources without deleting")
    .option("--force", "Actually delete matched resources")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions & CleanupOptions) =>
      runAction(async () => {
        const value = await client().apiPost<unknown>(
          apiPath(`/workspaces/${enc(id)}/cleanup`),
          cleanupBody(opts),
        );
        printValue(unwrap(value), opts);
      }),
    );

  workspaces
    .command("computers <workspace-id>")
    .description("List computers that belong to a tenant workspace")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/workspaces/${enc(id)}/computers`, opts)),
    );

  // ── Open-computer host workspaces (/opencomputers/hosts/:id/workspaces) ─
  // These use the `host-*` prefix to avoid collision with the tenant commands above.

  workspaces
    .command("host-list [host-id]")
    .description(
      "List open-computer host workspaces (omit host-id to list all hosts)",
    )
    .option("--json", "Output as JSON")
    .action((hostId: string | undefined, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          hostId
            ? `/opencomputers/hosts/${enc(hostId)}/workspaces`
            : "/opencomputers/workspaces",
          opts,
        ),
      ),
    );

  addDataOption(
    workspaces
      .command("host-create <host-id>")
      .description("Create a host workspace"),
  )
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/workspaces`,
          opts,
          {},
        ),
      ),
    );

  workspaces
    .command("host-show <host-id> <workspace-id>")
    .description("Show a host workspace")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}`,
          opts,
        ),
      ),
    );

  workspaces
    .command("host-delete <host-id> <workspace-id>")
    .description("Delete a host workspace")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}`,
          opts,
        ),
      ),
    );

  addDataOption(
    workspaces
      .command("host-action <host-id> <workspace-id> <action>")
      .description("Run workspace action: pull, open-terminal, run, expose"),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        hostId: string,
        workspaceId: string,
        action: string,
        opts: DataOptions,
      ) =>
        runAction(async () => {
          requireAction(action, actions);
          await postAndPrint(
            `/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}/${enc(action)}`,
            opts,
          );
        }),
    );

  workspaces
    .command("host-events <host-id> <workspace-id>")
    .description("Show host workspace events")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}/events`,
          opts,
        ),
      ),
    );
}

type CleanupOptions = {
  resourceType?: string;
  state?: string;
  namePrefix?: string;
  tag?: string;
  olderThan?: string;
  limit?: string;
  dryRun?: boolean;
  force?: boolean;
};

function cleanupBody(opts: CleanupOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.resourceType) body["resource_type"] = opts.resourceType;
  if (opts.state) body["state"] = opts.state;
  if (opts.namePrefix) body["name_prefix"] = opts.namePrefix;
  if (opts.tag) body["tag"] = opts.tag;
  if (opts.olderThan) body["older_than"] = opts.olderThan;
  if (opts.limit) body["limit"] = Number.parseInt(opts.limit, 10);
  if (opts.dryRun) body["dry_run"] = true;
  if (opts.force) body["force"] = true;
  return body;
}

function queryString(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== false) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}
