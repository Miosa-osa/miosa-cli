import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";
import { loadLocalLink } from "./link.js";
import type { EnvVarPreview } from "../types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

interface RevealedSecret {
  name: string;
  value: string;
}

/** Fetch revealed secret values via the secrets API. */
async function fetchSecretValues(
  client: MiosaClient,
  deploymentId: string,
): Promise<RevealedSecret[]> {
  // Primary path: deployment env vars (previews only — values not revealable
  // through the deployment env endpoint, so we fall back to tenant secrets).
  const envVars = await client.apiGet<{ data: EnvVarPreview[] }>(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}/env`,
  );

  const previews = envVars.data;

  if (previews.length === 0) return [];

  // Attempt to reveal each secret through the tenant secrets endpoint.
  // If the API does not support reveal, we surface the preview value with a
  // warning rather than failing the whole command.
  const tenantSecrets = await client
    .apiGet<{
      data: Array<{ id: string; name: string }>;
    }>("/api/v1/opencomputers/secrets")
    .catch(() => ({ data: [] as Array<{ id: string; name: string }> }));

  const secretsByName = new Map(tenantSecrets.data.map((s) => [s.name, s.id]));

  const results: RevealedSecret[] = [];

  for (const preview of previews) {
    const secretId = secretsByName.get(preview.name);
    if (secretId) {
      try {
        const revealed = await client.apiPost<{
          data?: { value?: string };
          value?: string;
        }>(
          `/api/v1/opencomputers/secrets/${encodeURIComponent(secretId)}/reveal`,
        );
        const value = revealed.data?.value ?? revealed.value ?? preview.preview;
        results.push({ name: preview.name, value });
        continue;
      } catch {
        // Fall through to preview value
      }
    }
    // Use preview as a sentinel so .env.local still contains the key
    results.push({ name: preview.name, value: preview.preview });
  }

  return results;
}

/** Serialise key-value pairs to dotenv format. */
function toDotenv(secrets: RevealedSecret[]): string {
  const lines = secrets.map(({ name, value }) => {
    // Quote values containing spaces, newlines, or special shell characters
    const needsQuotes = /[\s"'\\#]/.test(value);
    const escaped = needsQuotes
      ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : value;
    return `${name}=${escaped}`;
  });
  return lines.join("\n") + "\n";
}

/** Ensure .env.local is listed in .gitignore. */
function ensureGitignored(dir: string, filename: string): void {
  const gitignore = path.join(dir, ".gitignore");
  try {
    const existing = fs.existsSync(gitignore)
      ? fs.readFileSync(gitignore, "utf8")
      : "";
    if (!existing.split("\n").some((l) => l.trim() === filename)) {
      fs.appendFileSync(gitignore, `\n${filename}\n`);
    }
  } catch {
    // Non-fatal — gitignore may not be writable
  }
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("pull")
    .description("Pull secrets from MIOSA and write them to .env.local")
    .option(
      "--output <file>",
      "Output file path (default: .env.local)",
      ".env.local",
    )
    .option("--app <id>", "Deployment ID (overrides .miosa.json)")
    .option("--overwrite", "Overwrite output file without prompting")
    .option("--json", "Print secrets as JSON instead of writing a file")
    .addHelpText(
      "after",
      `
Examples:
  miosa pull                       Pull secrets into .env.local
  miosa pull --output .env         Write to .env instead
  miosa pull --app <id>            Pull from a specific deployment
  miosa pull --json                Print secrets as JSON (no file written)
`,
    )
    .action(
      async (opts: {
        output: string;
        app?: string;
        overwrite?: boolean;
        json?: boolean;
      }) => {
        try {
          const cwd = process.cwd();
          const config = loadConfig();
          const client = new MiosaClient(config);

          // Resolve deployment ID
          let deploymentId: string;
          let projectName: string;

          if (opts.app) {
            deploymentId = opts.app;
            projectName = opts.app.slice(0, 8);
          } else {
            const link = loadLocalLink(cwd);
            if (!link) {
              throw new UserError(
                "No .miosa.json found. Run `miosa link` first or pass --app <id>.",
              );
            }
            deploymentId = link.deploymentId;
            projectName = link.name;
          }

          const spinner = spin(
            `Pulling secrets from ${chalk.bold(projectName)}...`,
          );
          const secrets = await fetchSecretValues(client, deploymentId);
          spinner.stop();

          if (secrets.length === 0) {
            console.log(chalk.dim("  No secrets found for this deployment."));
            return;
          }

          if (opts.json) {
            const obj: Record<string, string> = {};
            for (const { name, value } of secrets) {
              obj[name] = value;
            }
            console.log(JSON.stringify(obj, null, 2));
            return;
          }

          const outputPath = path.resolve(cwd, opts.output);

          // Prompt before overwriting unless --overwrite passed
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

          fs.writeFileSync(outputPath, toDotenv(secrets), { mode: 0o600 });
          ensureGitignored(cwd, path.basename(outputPath));

          console.log(
            `Pulled ${chalk.bold(String(secrets.length))} secrets from ${chalk.bold(projectName)}`,
          );
          console.log(chalk.dim(`Written to ${opts.output} (gitignored)`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}
