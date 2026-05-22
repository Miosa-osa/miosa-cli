import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  patchAndPrint,
  postAndPrint,
  requireAction,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

const actions = ["pull", "open-terminal", "run", "expose"] as const;

export function register(program: Command): void {
  const workspaces = program
    .command("workspaces")
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
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/workspaces/${enc(id)}`, opts)),
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
