import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  resourceCommands,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "groups",
    description: "Manage OpenComputers host groups",
    route: "/opencomputers/groups",
    itemName: "group-id",
  });

  const groups = program.commands.find((cmd) => cmd.name() === "groups");
  groups!
    .command("add-member <group-id> <host-id>")
    .description("Add a host to a group")
    .option("--json", "Output as JSON")
    .action((groupId: string, hostId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/opencomputers/groups/${enc(groupId)}/members/${enc(hostId)}`,
          opts,
        ),
      ),
    );

  groups!
    .command("remove-member <group-id> <host-id>")
    .description("Remove a host from a group")
    .option("--json", "Output as JSON")
    .action((groupId: string, hostId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/opencomputers/groups/${enc(groupId)}/members/${enc(hostId)}`,
          opts,
        ),
      ),
    );

  addDataOption(groups!.command("add-members <group-id>").description("Bulk add group members"))
    .option("--json", "Output as JSON")
    .action((groupId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/groups/${enc(groupId)}/members`, opts, {}),
      ),
    );

  addDataOption(groups!.command("exec <group-id>").description("Run bulk exec for a group"))
    .option("--json", "Output as JSON")
    .action((groupId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/groups/${enc(groupId)}/exec`, opts, {}),
      ),
    );

  addDataOption(
    groups!
      .command("install-app <group-id> <app-id>")
      .description("Install an app on all hosts in a group"),
  )
    .option("--json", "Output as JSON")
    .action((groupId: string, appId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(
          `/opencomputers/groups/${enc(groupId)}/apps/${enc(appId)}/install`,
          opts,
          {},
        ),
      ),
    );

  groups!
    .command("tags")
    .description("List OpenComputers host tags")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/opencomputers/tags", opts)),
    );
}
