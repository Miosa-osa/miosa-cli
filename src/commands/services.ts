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
  const services = program.command("services").description("Manage long-running services on Computers");

  services.command("list <computer-id>").description("List services").option("--json", "Output as JSON").action((id: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/computers/${enc(id)}/services`, opts)),
  );

  addDataOption(services.command("create <computer-id>").description("Create a service"))
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => postAndPrint(`/computers/${enc(id)}/services`, opts, {})),
    );

  services.command("show <computer-id> <name>").description("Show a service").option("--json", "Output as JSON").action((id: string, name: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/computers/${enc(id)}/services/${enc(name)}`, opts)),
  );

  services.command("delete <computer-id> <name>").description("Delete a service").option("--json", "Output as JSON").action((id: string, name: string, opts: JsonOptions) =>
    runAction(() => deleteAndPrint(`/computers/${enc(id)}/services/${enc(name)}`, opts)),
  );

  addDataOption(services.command("action <computer-id> <name> <action>").description("Run service action: start, stop, restart"))
    .option("--json", "Output as JSON")
    .action((id: string, name: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(action, actions);
        await postAndPrint(`/computers/${enc(id)}/services/${enc(name)}/${enc(action)}`, opts);
      }),
    );

  services.command("logs <computer-id> <name>").description("Show service logs").option("--json", "Output as JSON").action((id: string, name: string, opts: JsonOptions) =>
    runAction(() => getAndPrint(`/computers/${enc(id)}/services/${enc(name)}/logs`, opts)),
  );
}
