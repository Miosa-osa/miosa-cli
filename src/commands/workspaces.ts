import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  requireAction,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

const actions = ["pull", "open-terminal", "run", "expose"] as const;

export function register(program: Command): void {
  const workspaces = program.command("workspaces").description("Manage workspaces");

  workspaces
    .command("list [host-id]")
    .description("List tenant workspaces, or host workspaces when host-id is provided")
    .option("--json", "Output as JSON")
    .action((hostId: string | undefined, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          hostId ? `/opencomputers/hosts/${enc(hostId)}/workspaces` : "/opencomputers/workspaces",
          opts,
        ),
      ),
    );

  addDataOption(workspaces.command("create <host-id>").description("Create a host workspace"))
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/workspaces`, opts, {}),
      ),
    );

  workspaces
    .command("show <host-id> <workspace-id>")
    .description("Show a host workspace")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}`, opts),
      ),
    );

  workspaces
    .command("delete <host-id> <workspace-id>")
    .description("Delete a host workspace")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}`, opts),
      ),
    );

  addDataOption(workspaces.command("action <host-id> <workspace-id> <action>").description("Run workspace action: pull, open-terminal, run, expose"))
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(action, actions);
        await postAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}/${enc(action)}`,
          opts,
        );
      }),
    );

  workspaces
    .command("events <host-id> <workspace-id>")
    .description("Show workspace events")
    .option("--json", "Output as JSON")
    .action((hostId: string, workspaceId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/workspaces/${enc(workspaceId)}/events`, opts),
      ),
    );
}
