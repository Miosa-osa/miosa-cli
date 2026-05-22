import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { spin } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import type { EnvVarPreview } from "../types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function parseKvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      throw new UserError(
        `Invalid KEY=VALUE pair: "${pair}"`,
        "Each argument must be in KEY=VALUE format.",
      );
    }
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

function printEnvTable(vars: EnvVarPreview[], opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(vars, null, 2));
    return;
  }
  if (vars.length === 0) {
    console.log(chalk.dim("  No env vars set."));
    return;
  }
  renderTable(vars, [
    { header: "NAME", key: "name", width: 32 },
    { header: "VALUE", key: (v) => chalk.dim(v.preview), width: 24 },
    {
      header: "UPDATED",
      key: (v) => new Date(v.updated_at).toLocaleString(),
      width: 22,
    },
  ]);
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const env = program
    .command("env")
    .description("Manage environment variables for a deployment")
    .addHelpText(
      "after",
      `
Examples:
  miosa env list <deployment-id>
  miosa env set <deployment-id> NODE_ENV=production PORT=3000
  miosa env unset <deployment-id> DEBUG
  miosa env pull <deployment-id>
  miosa env pull <deployment-id> --output .env
`,
    );

  // ── env list ────────────────────────────────────────────────────────────────

  env
    .command("list <deployment-id>")
    .description("List env var names and masked previews")
    .option("--json", "Output as JSON")
    .action(async (deploymentId: string, opts: { json?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const spinner = spin("Fetching env vars...");
        const vars = await client.getDeploymentEnv(
          resolveDeploymentId(deploymentId),
        );
        spinner.stop();
        printEnvTable(vars, opts);
      } catch (err) {
        handleError(err);
      }
    });

  // ── env set ─────────────────────────────────────────────────────────────────

  env
    .command("set <deployment-id> <pairs...>")
    .description("Set one or more env vars (KEY=VALUE)")
    .option("--json", "Output as JSON")
    .action(
      async (
        deploymentId: string,
        pairs: string[],
        opts: { json?: boolean },
      ) => {
        try {
          const kvs = parseKvPairs(pairs);
          const client = new MiosaClient(loadConfig());
          const spinner = spin(
            `Setting ${Object.keys(kvs).length} env var(s)...`,
          );
          const vars = await client.setDeploymentEnv(
            resolveDeploymentId(deploymentId),
            kvs,
          );
          spinner.succeed(`Set ${vars.length} env var(s)`);
          printEnvTable(vars, opts);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── env unset ───────────────────────────────────────────────────────────────

  env
    .command("unset <deployment-id> <key>")
    .description("Remove an env var")
    .option("--json", "Output as JSON")
    .action(
      async (deploymentId: string, key: string, opts: { json?: boolean }) => {
        try {
          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);
          const spinner = spin(`Unsetting ${key}...`);
          const result = await client.apiDelete<unknown>(
            `/api/v1/deployments/${encodeURIComponent(id)}/env/${encodeURIComponent(key)}`,
          );
          spinner.succeed(`Unset ${key}`);
          if (opts.json) {
            console.log(JSON.stringify(result ?? { deleted: true }, null, 2));
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── env pull ────────────────────────────────────────────────────────────────

  env
    .command("pull <deployment-id>")
    .description("Download env vars to a local .env file")
    .option("--output <file>", "Output file path", ".env.local")
    .option("--overwrite", "Overwrite without prompting")
    .option("--json", "Print as JSON without writing a file")
    .action(
      async (
        deploymentId: string,
        opts: { output: string; overwrite?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);
          const spinner = spin("Pulling env vars...");
          const vars = await client.getDeploymentEnv(id);
          spinner.stop();

          if (vars.length === 0) {
            console.log(chalk.dim("  No env vars set for this deployment."));
            return;
          }

          if (opts.json) {
            const obj: Record<string, string> = {};
            for (const v of vars) obj[v.name] = v.preview;
            console.log(JSON.stringify(obj, null, 2));
            return;
          }

          const outputPath = path.resolve(process.cwd(), opts.output);

          if (!opts.overwrite && fs.existsSync(outputPath)) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `${opts.output} already exists. Overwrite?`,
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("  Cancelled."));
              process.exit(0);
            }
          }

          const lines = vars
            .map(({ name, preview }) => `${name}=${preview}`)
            .join("\n");
          fs.writeFileSync(outputPath, lines + "\n", { mode: 0o600 });

          // Ensure .gitignore includes the output file
          const gitignore = path.join(process.cwd(), ".gitignore");
          const basename = path.basename(outputPath);
          try {
            const existing = fs.existsSync(gitignore)
              ? fs.readFileSync(gitignore, "utf8")
              : "";
            if (!existing.split("\n").some((l) => l.trim() === basename)) {
              fs.appendFileSync(gitignore, `\n${basename}\n`);
            }
          } catch {
            // Non-fatal
          }

          console.log(
            `Wrote ${chalk.bold(String(vars.length))} env vars to ${chalk.cyan(opts.output)} ${chalk.dim("(gitignored)")}`,
          );
        } catch (err) {
          handleError(err);
        }
      },
    );
}
