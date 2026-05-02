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

const actions = ["start", "stop", "restart"] as const;

export function register(program: Command): void {
  const containers = program.command("containers").description("Manage containers on OpenComputers hosts");

  containers.command("list <host-id>").description("List containers").option("--json", "Output as JSON").action((hostId: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers`, opts)),
  );

  addDataOption(containers.command("create <host-id>").description("Create a container"))
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers`, opts, {}),
      ),
    );

  containers.command("show <host-id> <container-id>").description("Show a container").option("--json", "Output as JSON").action((hostId: string, id: string, opts: JsonOptions) =>
    runAction(() =>
      getAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers/${enc(id)}`, opts),
    ),
  );

  containers.command("delete <host-id> <container-id>").description("Delete a container").option("--json", "Output as JSON").action((hostId: string, id: string, opts: JsonOptions) =>
    runAction(() =>
      deleteAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers/${enc(id)}`, opts),
    ),
  );

  addDataOption(containers.command("action <host-id> <container-id> <action>").description("Run container action: start, stop, restart"))
    .option("--json", "Output as JSON")
    .action((hostId: string, id: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(action, actions);
        await postAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/containers/${enc(id)}/${enc(action)}`,
          opts,
        );
      }),
    );

  containers.command("logs <host-id> <container-id>").description("Show container logs").option("--json", "Output as JSON").action((hostId: string, id: string, opts: JsonOptions) =>
    runAction(() =>
      getAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers/${enc(id)}/logs`, opts),
    ),
  );

  containers.command("stats <host-id> <container-id>").description("Show container stats").option("--json", "Output as JSON").action((hostId: string, id: string, opts: JsonOptions) =>
    runAction(() =>
      getAndPrint(`/opencomputers/hosts/${enc(hostId)}/containers/${enc(id)}/stats`, opts),
    ),
  );
}
