import type { Command } from "commander";
import {
  apiPath,
  client,
  deleteAndPrint,
  enc,
  getAndPrint,
  printValue,
  runAction,
  unwrap,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const cron = program
    .command("cron")
    .description("Manage cron jobs on a computer");

  // list <computer-id>
  cron
    .command("list <computer-id>")
    .description("List cron jobs for a computer")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/cron-jobs?computer_id=${enc(computerId)}`),
          ),
        );
        printValue(value, opts);
      }),
    );

  // create <computer-id> --schedule <expr> --command <cmd>
  cron
    .command("create <computer-id>")
    .description("Create a cron job")
    .requiredOption("--schedule <expr>", "Cron expression (e.g. */5 * * * *)")
    .requiredOption("--command <cmd>", "Command to run")
    .option("--name <name>", "Job name")
    .option("--json", "Output as JSON")
    .action(
      (
        computerId: string,
        opts: JsonOptions & {
          schedule: string;
          command: string;
          name?: string;
        },
      ) =>
        runAction(async () => {
          const body: Record<string, string> = {
            computer_id: computerId,
            schedule: opts.schedule,
            command: opts.command,
          };
          if (opts.name) body["name"] = opts.name;
          const value = unwrap(
            await client().apiPost<unknown>(apiPath("/cron-jobs"), body),
          );
          printValue(value, opts);
        }),
    );

  // get <computer-id> <cron-id>
  cron
    .command("get <computer-id> <cron-id>")
    .description("Show a cron job")
    .option("--json", "Output as JSON")
    .action((_computerId: string, cronId: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/cron-jobs/${enc(cronId)}`, opts)),
    );

  // delete <computer-id> <cron-id>
  cron
    .command("delete <computer-id> <cron-id>")
    .description("Delete a cron job")
    .option("--json", "Output as JSON")
    .action((_computerId: string, cronId: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/cron-jobs/${enc(cronId)}`, opts)),
    );

  // pause <computer-id> <cron-id>
  cron
    .command("pause <computer-id> <cron-id>")
    .description("Pause a cron job")
    .option("--json", "Output as JSON")
    .action((_computerId: string, cronId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/cron-jobs/${enc(cronId)}/pause`),
          ),
        );
        printValue(value, opts);
      }),
    );

  // resume <computer-id> <cron-id>
  cron
    .command("resume <computer-id> <cron-id>")
    .description("Resume a cron job")
    .option("--json", "Output as JSON")
    .action((_computerId: string, cronId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/cron-jobs/${enc(cronId)}/resume`),
          ),
        );
        printValue(value, opts);
      }),
    );
}
