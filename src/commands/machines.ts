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

const actions = ["start", "stop", "restart", "clone", "resize", "move"] as const;

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "machines",
    description: "Manage persistent machines",
    route: "/computers",
    itemName: "machine-id",
    actions,
  });

  const machines = program.commands.find((cmd) => cmd.name() === "machines");
  addDataOption(
    machines!
      .command("exec <machine-id>")
      .description("Run a command on a machine via the raw exec API"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => postAndPrint(`/computers/${enc(id)}/exec`, opts, {})),
    );

  machines!
    .command("logs <machine-id>")
    .description("Show machine logs")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/computers/${enc(id)}/logs`, opts)),
    );

  machines!
    .command("delete-snapshot <machine-id> <snapshot-id>")
    .description("Delete a machine snapshot")
    .option("--json", "Output as JSON")
    .action((id: string, sid: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/computers/${enc(id)}/snapshots/${enc(sid)}`, opts),
      ),
    );
}
