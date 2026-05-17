import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";
import type { Deployment, DeploymentId, LocalProjectLink } from "../types.js";
import { toDeploymentId } from "../types.js";

// ── .miosa.json helpers ───────────────────────────────────────────────────────

const LINK_FILE = ".miosa.json";

export function loadLocalLink(dir = process.cwd()): LocalProjectLink | null {
  const file = path.join(dir, LINK_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LocalProjectLink;
  } catch {
    return null;
  }
}

export function saveLocalLink(dir: string, link: LocalProjectLink): void {
  const file = path.join(dir, LINK_FILE);
  fs.writeFileSync(file, JSON.stringify(link, null, 2) + "\n");
}

export function requireLocalLink(dir = process.cwd()): LocalProjectLink {
  const link = loadLocalLink(dir);
  if (!link) {
    throw new UserError(
      "No .miosa.json found in current directory.",
      "Run `miosa link` to connect this directory to a MIOSA project.",
    );
  }
  return link;
}

export function resolveLinkedDeploymentId(
  id?: string,
  dir = process.cwd(),
): DeploymentId {
  if (id) return toDeploymentId(id);
  const link = loadLocalLink(dir);
  if (link?.deploymentId) return link.deploymentId;
  throw new UserError(
    "No deployment linked. Pass --app <id> or run `miosa link` first.",
  );
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("link")
    .description(
      "Link this directory to a MIOSA deployment (writes .miosa.json)",
    )
    .option("--app <id>", "Deployment ID to link (skip interactive prompt)")
    .option(
      "--env <env>",
      "Environment label (e.g. production, staging)",
      "production",
    )
    .addHelpText(
      "after",
      `
Examples:
  miosa link                   Interactive — choose from your deployments
  miosa link --app <id>        Link directly without prompts
`,
    )
    .action(async (opts: { app?: string; env: string }) => {
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);

        let deployment: Deployment;
        let environment = opts.env;

        if (opts.app) {
          // Direct link — resolve from API to get the full deployment record
          const spinner = spin("Fetching deployment...");
          const deploymentId = toDeploymentId(opts.app);
          const dep = await client.apiGet<{ data: Deployment }>(
            `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
          );
          deployment = dep.data;
          spinner.stop();
        } else {
          // Interactive: list deployments, let user pick
          const spinner = spin("Fetching deployments...");
          const response = await client.apiGet<{ data: Deployment[] }>(
            "/api/v1/deployments",
          );
          const deployments = response.data;
          spinner.stop();

          if (deployments.length === 0) {
            console.log(chalk.yellow("  No deployments found."));
            console.log(chalk.dim("  Create one first with: miosa deploy"));
            process.exit(0);
          }

          const { default: inquirer } = await import("inquirer");

          const answers = await inquirer.prompt<{
            deploymentId: string;
            env: string;
          }>([
            {
              type: "list",
              name: "deploymentId",
              message: "Select a project:",
              choices: deployments.map((d) => ({
                name: `${d.name} ${chalk.dim("(" + d.slug + ")")}`,
                value: d.id,
              })),
            },
            {
              type: "input",
              name: "env",
              message: "Environment:",
              default: opts.env,
            },
          ]);

          const matched = deployments.find(
            (d) => d.id === answers.deploymentId,
          );
          if (!matched) throw new UserError("Selected deployment not found.");
          deployment = matched;
          environment = answers.env;
        }

        const link: LocalProjectLink = {
          version: 1,
          deploymentId: deployment.id,
          name: deployment.name,
          environment,
        };

        saveLocalLink(cwd, link);

        console.log();
        console.log(
          `${chalk.green("Linked")} to ${chalk.bold(deployment.name)} ${chalk.dim("(" + environment + ")")}`,
        );
        console.log(chalk.dim(`Written to ${LINK_FILE}`));
        console.log();
        console.log(chalk.dim("Next steps:"));
        console.log(
          chalk.dim("  miosa pull       — download secrets to .env.local"),
        );
        console.log(
          chalk.dim(
            "  miosa dev        — start dev server with secrets injected",
          ),
        );
      } catch (err) {
        handleError(err);
      }
    });
}
