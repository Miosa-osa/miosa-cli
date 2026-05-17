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
  const checkpoints = program
    .command("checkpoints")
    .description("Manage Computer checkpoints (Firecracker snapshots)");

  checkpoints
    .command("list <computer-id>")
    .description("List all checkpoints for a Computer")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/computers/${enc(computerId)}/snapshots`, opts),
      ),
    );

  addDataOption(
    checkpoints
      .command("create <computer-id>")
      .description("Create a checkpoint of a running Computer")
      .option("--name <name>", "Optional name/comment for the checkpoint"),
  )
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: DataOptions & { name?: string }) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(computerId)}/snapshots`,
          opts,
          opts.name ? { comment: opts.name } : {},
        ),
      ),
    );

  checkpoints
    .command("get <computer-id> <checkpoint-id>")
    .description("Show a single checkpoint")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          `/computers/${enc(computerId)}/snapshots/${enc(checkpointId)}`,
          opts,
        ),
      ),
    );

  checkpoints
    .command("restore <computer-id> <checkpoint-id>")
    .description("Restore a checkpoint onto a fresh Computer")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(computerId)}/restore/${enc(checkpointId)}`,
          { ...opts },
          {},
        ),
      ),
    );

  checkpoints
    .command("delete <computer-id> <checkpoint-id>")
    .description("Delete a checkpoint")
    .option("--json", "Output as JSON")
    .action((computerId: string, checkpointId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/computers/${enc(computerId)}/snapshots/${enc(checkpointId)}`,
          opts,
        ),
      ),
    );
}
