import type { Command } from "commander";
import {
  addDataOption,
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
    command: "webhooks",
    description: "Manage webhooks",
    route: "/webhooks",
    itemName: "webhook-id",
    actions: ["test"],
  });

  const webhooks = program.commands.find((cmd) => cmd.name() === "webhooks");
  webhooks!
    .command("events")
    .description("List supported webhook event types and signing metadata")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/webhooks/events", opts)),
    );

  webhooks!
    .command("deliveries <webhook-id>")
    .description("List webhook deliveries")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/webhooks/${enc(id)}/deliveries`, opts)),
    );

  addDataOption(
    webhooks!
      .command("test <webhook-id>")
      .description("Send a webhook test delivery"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => postAndPrint(`/webhooks/${enc(id)}/test`, opts)),
    );
}
