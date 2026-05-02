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

const alertKinds = ["rules", "channels", "fires"] as const;

export function register(program: Command): void {
  const alerts = program.command("alerts").description("Manage alert rules, channels, and fires");

  alerts
    .command("list <kind>")
    .description("List alert rules, channels, or fires")
    .option("--json", "Output as JSON")
    .action((kind: string, opts: JsonOptions) =>
      runAction(async () => {
        requireAction(kind, alertKinds);
        await getAndPrint(`/opencomputers/alerts/${enc(kind)}`, opts);
      }),
    );

  addDataOption(alerts.command("create <kind>").description("Create an alert rule or channel"))
    .option("--json", "Output as JSON")
    .action((kind: string, opts: DataOptions) =>
      runAction(async () => {
        requireAction(kind, ["rules", "channels"]);
        await postAndPrint(`/opencomputers/alerts/${enc(kind)}`, opts, {});
      }),
    );

  alerts
    .command("delete <kind> <id>")
    .description("Delete an alert rule or channel")
    .option("--json", "Output as JSON")
    .action((kind: string, id: string, opts: JsonOptions) =>
      runAction(async () => {
        requireAction(kind, ["rules", "channels"]);
        await deleteAndPrint(`/opencomputers/alerts/${enc(kind)}/${enc(id)}`, opts);
      }),
    );

  addDataOption(alerts.command("action <kind> <id> <action>").description("Run alert action: fire-test, verify, ack"))
    .option("--json", "Output as JSON")
    .action((kind: string, id: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        if (kind === "rules") requireAction(action, ["fire-test"]);
        else if (kind === "channels") requireAction(action, ["verify"]);
        else if (kind === "fires") requireAction(action, ["ack"]);
        else requireAction(kind, alertKinds);
        await postAndPrint(`/opencomputers/alerts/${enc(kind)}/${enc(id)}/${enc(action)}`, opts);
      }),
    );
}
