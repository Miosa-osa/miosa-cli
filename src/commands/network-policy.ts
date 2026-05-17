import type { Command } from "commander";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  putAndPrint,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";

export function register(program: Command): void {
  const policy = program
    .command("network-policy")
    .description("Manage egress network policy for a Computer");

  policy
    .command("get <computer-id>")
    .description("Show the current network policy (default: allow-all)")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/computers/${enc(computerId)}/network-policy`, opts),
      ),
    );

  addDataOption(
    policy
      .command("set <computer-id>")
      .description(
        "Create or replace the network policy. Use --rules or --data for full body",
      )
      .option(
        "--rules <json>",
        'JSON array of policy rules, e.g. \'[{"effect":"deny","destination":"0.0.0.0/0"}]\'',
      )
      .option(
        "--default-effect <effect>",
        "Default effect when no rule matches: allow | deny",
      ),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        computerId: string,
        opts: DataOptions & { rules?: string; defaultEffect?: string },
      ) =>
        runAction(() => {
          let defaultBody: Record<string, unknown> = {};
          if (opts.rules !== undefined) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(opts.rules);
            } catch {
              throw new Error("--rules must be a valid JSON array");
            }
            defaultBody["rules"] = parsed;
          }
          if (opts.defaultEffect !== undefined) {
            defaultBody["default_effect"] = opts.defaultEffect;
          }
          return putAndPrint(
            `/computers/${enc(computerId)}/network-policy`,
            opts,
            defaultBody,
          );
        }),
    );

  policy
    .command("reset <computer-id>")
    .description("Reset to the default allow-all policy")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/computers/${enc(computerId)}/network-policy`, opts),
      ),
    );
}
