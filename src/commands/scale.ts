import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import { printObject } from "./enterprise-util.js";

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("scale <deployment-id>")
    .description("Scale or resize a deployment")
    .option("--instances <n>", "Target instance count")
    .option("--size <size>", "Instance size (e.g. small, medium, large)")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa scale <id> --instances 3
  miosa scale <id> --size medium
  miosa scale <id> --instances 2 --size large
`,
    )
    .action(
      async (
        deploymentId: string,
        opts: { instances?: string; size?: string; json?: boolean },
      ) => {
        try {
          if (!opts.instances && !opts.size) {
            throw new UserError(
              "Specify at least --instances or --size.",
              "Example: miosa scale <id> --instances 2",
            );
          }

          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);

          if (opts.instances !== undefined) {
            const n = Number(opts.instances);
            if (!Number.isInteger(n) || n < 0) {
              throw new UserError(
                `--instances must be a non-negative integer, got: ${opts.instances}`,
              );
            }

            const spinner = spin(`Scaling to ${n} instance(s)...`);
            const result = await client.apiPost<unknown>(
              `/api/v1/deployments/${encodeURIComponent(id)}/scale`,
              { instances: n },
            );
            spinner.succeed(`Scaled to ${n} instance(s)`);

            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
            } else if (result && typeof result === "object") {
              printObject(result as Record<string, unknown>);
            }
          }

          if (opts.size !== undefined) {
            const spinner = spin(`Resizing to ${opts.size}...`);
            const result = await client.apiPost<unknown>(
              `/api/v1/deployments/${encodeURIComponent(id)}/resize`,
              { size: opts.size },
            );
            spinner.succeed(`Resized to ${opts.size}`);

            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
            } else if (result && typeof result === "object") {
              printObject(result as Record<string, unknown>);
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
