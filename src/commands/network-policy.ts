import type { Command } from "commander";
import chalk from "chalk";
import {
  addDataOption,
  client,
  apiPath,
  enc,
  unwrap,
  runAction,
  type ApiObject,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { hintBlock, icon, kvPanel, printBanner } from "../ui/render.js";
import { renderTable } from "../ui/table.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtEffect(e: unknown): string {
  const str = String(e ?? "");
  if (str === "allow") return chalk.green(str);
  if (str === "deny") return chalk.red(str);
  return chalk.dim(str || "—");
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const policy = program
    .command("network-policy")
    .description("Manage egress network policy for a Computer");

  // ── get ────────────────────────────────────────────────────────────────────
  policy
    .command("get <computer-id>")
    .description("Show the current network policy (default: allow-all)")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/computers/${enc(computerId)}/network-policy`),
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const pol = value as ApiObject;
        const rules = Array.isArray(pol["rules"])
          ? (pol["rules"] as ApiObject[])
          : [];

        printBanner({ subtitle: "Network Policy" });
        console.log(
          kvPanel([
            { label: "Computer", value: chalk.dim(computerId) },
            {
              label: "Default effect",
              value: fmtEffect(pol["default_effect"] ?? "allow"),
            },
            {
              label: "Rules",
              value: chalk.dim(`${rules.length} rule(s)`),
            },
          ]),
        );

        if (rules.length > 0) {
          console.log();
          renderTable<ApiObject>(rules, [
            { header: "EFFECT", key: (r) => fmtEffect(r["effect"]), width: 8 },
            {
              header: "DESTINATION",
              key: (r) => chalk.bold(String(r["destination"] ?? "—")),
            },
            {
              header: "PROTOCOL",
              key: (r) => chalk.dim(String(r["protocol"] ?? "any")),
              width: 10,
            },
            {
              header: "PORT",
              key: (r) => chalk.dim(String(r["port"] ?? "any")),
              width: 8,
            },
          ]);
        }

        console.log();
        console.log(
          hintBlock("Try", [
            `miosa network-policy set ${computerId} --default-effect deny`,
            `miosa network-policy set ${computerId} --rules '[{"effect":"allow","destination":"10.0.0.0/8"}]'`,
            `miosa network-policy reset ${computerId}`,
          ]),
        );
        console.log();
      }),
    );

  // ── set ────────────────────────────────────────────────────────────────────
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
        runAction(async () => {
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

          const value = unwrap(
            await client().apiPut<unknown>(
              apiPath(`/computers/${enc(computerId)}/network-policy`),
              defaultBody,
            ),
          );

          if (opts.json) {
            console.log(JSON.stringify(value, null, 2));
            return;
          }

          const pol = value as ApiObject;
          const rules = Array.isArray(pol["rules"])
            ? (pol["rules"] as unknown[])
            : [];

          printBanner({ subtitle: "Network Policy updated" });
          console.log(
            kvPanel([
              {
                icon: icon.ok,
                label: "Computer",
                value: chalk.dim(computerId),
              },
              {
                icon: icon.ok,
                label: "Default effect",
                value: fmtEffect(
                  pol["default_effect"] ?? opts.defaultEffect ?? "allow",
                ),
              },
              {
                icon: icon.ok,
                label: "Rules",
                value: chalk.dim(`${rules.length} rule(s)`),
              },
            ]),
          );
          console.log();
          console.log(
            hintBlock("Next", [
              `miosa network-policy get ${computerId}`,
              `miosa network-policy reset ${computerId}`,
            ]),
          );
          console.log();
        }),
    );

  // ── reset ──────────────────────────────────────────────────────────────────
  policy
    .command("reset <computer-id>")
    .description("Reset to the default allow-all policy")
    .option("--json", "Output as JSON")
    .action((computerId: string, opts: JsonOptions) =>
      runAction(async () => {
        await client().apiDelete<unknown>(
          apiPath(`/computers/${enc(computerId)}/network-policy`),
        );

        if (opts.json) {
          console.log(
            JSON.stringify(
              { reset: true, default_effect: "allow", computer_id: computerId },
              null,
              2,
            ),
          );
          return;
        }

        console.log();
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "Reset",
              value: chalk.dim("allow-all restored"),
            },
            { label: "Computer", value: chalk.dim(computerId) },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Try", [`miosa network-policy get ${computerId}`]),
        );
        console.log();
      }),
    );
}
