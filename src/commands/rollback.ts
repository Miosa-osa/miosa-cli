import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import { printObject } from "./enterprise-util.js";

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("rollback <deployment-id>")
    .description("Roll a deployment back to a previous version")
    .option("--to <version-id>", "Specific version/build ID to roll back to")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa rollback <deployment-id>
  miosa rollback <deployment-id> --to <build-id>
  miosa rollback <deployment-id> --to <build-id> --yes
`,
    )
    .action(
      async (
        deploymentId: string,
        opts: { to?: string; yes?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);

          if (!opts.yes) {
            const target = opts.to
              ? `build ${opts.to.slice(0, 8)}`
              : "the previous build";
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.yellow(
                  `Roll back deployment ${id.slice(0, 8)} to ${target}?`,
                ),
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("  Cancelled."));
              process.exit(0);
            }
          }

          const spinner = spin("Initiating rollback...");
          const body: Record<string, string> = {};
          if (opts.to) body["version_id"] = opts.to;

          const result = await client.apiPost<unknown>(
            `/api/v1/deployments/${encodeURIComponent(id)}/rollback`,
            body,
          );
          spinner.succeed("Rollback initiated");

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else if (result && typeof result === "object") {
            printObject(result as Record<string, unknown>);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
