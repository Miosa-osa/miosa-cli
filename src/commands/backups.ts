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
  const backups = program.command("backups").description("Manage OpenComputers backup configs and snapshots");

  backups.command("list <host-id>").description("List backup configs").option("--json", "Output as JSON").action((hostId: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/opencomputers/hosts/${enc(hostId)}/backup-configs`, opts)),
  );

  addDataOption(backups.command("create <host-id>").description("Create a backup config"))
    .option("--json", "Output as JSON")
    .action((hostId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/hosts/${enc(hostId)}/backup-configs`, opts, {}),
      ),
    );

  backups.command("delete <host-id> <config-id>").description("Delete a backup config").option("--json", "Output as JSON").action((hostId: string, configId: string, opts: JsonOptions) =>
    runAction(() =>
      deleteAndPrint(`/opencomputers/hosts/${enc(hostId)}/backup-configs/${enc(configId)}`, opts),
    ),
  );

  addDataOption(backups.command("action <host-id> <config-id> <action>").description("Run a backup config action: pause, resume, trigger"))
    .option("--json", "Output as JSON")
    .action((hostId: string, configId: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(action, actions);
        await postAndPrint(
          `/opencomputers/hosts/${enc(hostId)}/backup-configs/${enc(configId)}/${enc(action)}`,
          opts,
        );
      }),
    );

  backups.command("snapshots <host-id> <config-id>").description("List snapshots for a backup config").option("--json", "Output as JSON").action((hostId: string, configId: string, opts: JsonOptions) =>
    runAction(() =>
      getAndPrint(`/opencomputers/hosts/${enc(hostId)}/backup-configs/${enc(configId)}/snapshots`, opts),
    ),
  );

  backups.command("show-snapshot <snapshot-id>").description("Show a snapshot").option("--json", "Output as JSON").action((snapshotId: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/opencomputers/snapshots/${enc(snapshotId)}`, opts)),
  );

  backups.command("delete-snapshot <snapshot-id>").description("Delete a snapshot").option("--json", "Output as JSON").action((snapshotId: string, opts: JsonOptions) =>
    runAction(() => deleteAndPrint(`/opencomputers/snapshots/${enc(snapshotId)}`, opts)),
  );

  addDataOption(backups.command("restore <snapshot-id>").description("Restore a snapshot"))
    .option("--json", "Output as JSON")
    .action((snapshotId: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/opencomputers/snapshots/${enc(snapshotId)}/restore`, opts),
      ),
    );
}
