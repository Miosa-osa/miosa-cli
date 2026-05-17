import type { Command } from "commander";
import {
  addDataOption,
  apiPath,
  client,
  deleteAndPrint,
  enc,
  getAndPrint,
  printValue,
  runAction,
  unwrap,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const fns = program.command("functions").description("Manage edge functions");

  // list
  fns
    .command("list")
    .description("List all functions")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/functions", opts)),
    );

  // get <id>
  fns
    .command("get <id>")
    .description("Show a function")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/functions/${enc(id)}`, opts)),
    );

  // create --name <name> [--runtime <runtime>] [--data <json>]
  addDataOption(
    fns
      .command("create")
      .description("Create a function")
      .requiredOption("--name <name>", "Function name")
      .option("--runtime <runtime>", "Runtime (e.g. python3.12, node20)"),
  )
    .option("--json", "Output as JSON")
    .action((opts: DataOptions & { name: string; runtime?: string }) =>
      runAction(async () => {
        const body = {
          name: opts.name,
          ...(opts.runtime ? { runtime: opts.runtime } : {}),
          ...(opts.data ? JSON.parse(opts.data) : {}),
        };
        const value = unwrap(
          await client().apiPost<unknown>(apiPath("/functions"), body),
        );
        printValue(value, opts);
      }),
    );

  // invoke <id> [--data '{}']
  addDataOption(
    fns.command("invoke <id>").description("Invoke a function synchronously"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(async () => {
        const body = opts.data ? JSON.parse(opts.data) : {};
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/functions/${enc(id)}/invoke`),
            body,
          ),
        );
        printValue(value, opts);
      }),
    );

  // delete <id>
  fns
    .command("delete <id>")
    .description("Delete a function")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/functions/${enc(id)}`, opts)),
    );
}
