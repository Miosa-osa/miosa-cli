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

const actions = ["pause", "resume", "trigger"] as const;

export function register(program: Command): void {
  const schedules = program
    .command("schedules")
    .description("Manage OpenComputers host schedules");

  schedules
    .command("list <host-id>")
    .description("List schedules for a host")
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/opencomputers/hosts/${enc(hostId)}/schedules`, opts)),
    );

  schedules
    .command("show <host-id> <schedule-id>")
    .description("Show a schedule")
    .option("--json", "Output as JSON")
    .action((hostId: string, id: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/schedules/${enc(id)}`, opts),
      ),
    );

  addDataOption(schedules.command("create <host-id>").description("Create a schedule"))
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/schedules`, opts, {}),
      ),
    );

  schedules
    .command("delete <host-id> <schedule-id>")
    .description("Delete a schedule")
    .option("--json", "Output as JSON")
    .action((hostId: string, id: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/opencomputers/hosts/${enc(hostId)}/schedules/${enc(id)}`, opts),
      ),
    );

  addDataOption(schedules.command("action <host-id> <schedule-id> <action>").description("Run a schedule action: pause, resume, trigger"))
    .option("--json", "Output as JSON")
    .action((hostId: string, id: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(action, actions);
        await postAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/schedules/${enc(id)}/${enc(action)}`,
          opts,
        );
      }),
    );

  schedules
    .command("runs <host-id> <schedule-id>")
    .description("List schedule runs")
    .option("--json", "Output as JSON")
    .action((hostId: string, id: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/schedules/${enc(id)}/runs`, opts),
      ),
    );
}
