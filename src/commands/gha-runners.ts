import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const runners = program.command("gha-runners").description("Manage GitHub Actions runners on OpenComputers hosts");

  runners
    .command("list <host-id>")
    .description("List runners for a host")
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners`, opts)),
    );

  addDataOption(runners.command("create <host-id>").description("Create a runner"))
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners`, opts, {}),
      ),
    );

  runners
    .command("show <host-id> <runner-id>")
    .description("Show a runner")
    .option("--json", "Output as JSON")
    .action((hostId: string, runnerId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners/${enc(runnerId)}`, opts),
      ),
    );

  runners
    .command("delete <host-id> <runner-id>")
    .description("Delete a runner")
    .option("--json", "Output as JSON")
    .action((hostId: string, runnerId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners/${enc(runnerId)}`, opts),
      ),
    );

  runners
    .command("refresh <host-id> <runner-id>")
    .description("Refresh runner state")
    .option("--json", "Output as JSON")
    .action((hostId: string, runnerId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners/${enc(runnerId)}/refresh`, opts),
      ),
    );

  runners
    .command("events <host-id> <runner-id>")
    .description("Show runner events")
    .option("--json", "Output as JSON")
    .action((hostId: string, runnerId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/opencomputers/hosts/${enc(hostId)}/gha-runners/${enc(runnerId)}/events`, opts),
      ),
    );
}
