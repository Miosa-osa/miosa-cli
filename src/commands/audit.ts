import type { Command } from "commander";
import { enc, getAndPrint, runAction, type JsonOptions } from "./enterprise-util.js";

export function register(program: Command): void {
  const audit = program.command("audit").description("Inspect OpenComputers audit logs");

  audit
    .command("list")
    .description("List audit events")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) => runAction(() => getAndPrint("/opencomputers/audit", opts)));

  audit
    .command("show <audit-id>")
    .description("Show an audit event")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/opencomputers/audit/${enc(id)}`, opts)),
    );

  audit
    .command("export")
    .description("Export audit events")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/opencomputers/audit/export", opts)),
    );

  audit
    .command("verify")
    .description("Verify the audit hash chain")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/opencomputers/audit/verify", opts)),
    );
}
