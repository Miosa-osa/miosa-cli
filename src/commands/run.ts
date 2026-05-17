import { spawn } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { handleError } from "./util.js";
import { loadLocalLink } from "./link.js";
import type { EnvVarPreview } from "../types.js";

// ── secret fetching ───────────────────────────────────────────────────────────

async function fetchEnvVars(
  client: MiosaClient,
  deploymentId: string,
): Promise<Record<string, string>> {
  const response = await client.apiGet<{ data: EnvVarPreview[] }>(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}/env`,
  );
  const previews = response.data;

  if (previews.length === 0) return {};

  const tenantSecrets = await client
    .apiGet<{
      data: Array<{ id: string; name: string }>;
    }>("/api/v1/opencomputers/secrets")
    .catch(() => ({ data: [] as Array<{ id: string; name: string }> }));

  const secretIdByName = new Map(tenantSecrets.data.map((s) => [s.name, s.id]));

  const env: Record<string, string> = {};

  for (const preview of previews) {
    const secretId = secretIdByName.get(preview.name);
    if (secretId) {
      try {
        const revealed = await client.apiPost<{
          data?: { value?: string };
          value?: string;
        }>(
          `/api/v1/opencomputers/secrets/${encodeURIComponent(secretId)}/reveal`,
        );
        env[preview.name] =
          revealed.data?.value ?? revealed.value ?? preview.preview;
        continue;
      } catch {
        // Fall through to preview
      }
    }
    env[preview.name] = preview.preview;
  }

  return env;
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("run <command...>")
    .description(
      "Run any command with MIOSA secrets injected as environment variables",
    )
    .allowUnknownOption(true)
    .option("--app <id>", "Deployment ID (overrides .miosa.json)")
    .option(
      "--no-secrets",
      "Skip secret injection — just run the command as-is",
    )
    .addHelpText(
      "after",
      `
Examples:
  miosa run npm test
  miosa run python manage.py migrate
  miosa run -- npx jest --watch
  miosa run --app <id> node scripts/seed.js
`,
    )
    .action(
      async (
        commandParts: string[],
        opts: { app?: string; secrets: boolean },
      ) => {
        try {
          if (commandParts.length === 0) {
            throw new UserError(
              "No command provided.",
              "Usage: miosa run <command> [args...]",
            );
          }

          const cwd = process.cwd();
          let injectedEnv: Record<string, string> = {};
          let secretCount = 0;
          let projectName = "project";

          if (opts.secrets !== false) {
            // Resolve deployment
            let deploymentId: string | null = null;

            if (opts.app) {
              deploymentId = opts.app;
              projectName = opts.app.slice(0, 8);
            } else {
              const link = loadLocalLink(cwd);
              if (link) {
                deploymentId = link.deploymentId;
                projectName = link.name;
              }
            }

            if (deploymentId) {
              const config = loadConfig();
              const client = new MiosaClient(config);

              process.stderr.write(
                chalk.dim(
                  `Injecting secrets from ${chalk.white(projectName)}... `,
                ),
              );

              try {
                injectedEnv = await fetchEnvVars(client, deploymentId);
                secretCount = Object.keys(injectedEnv).length;
                process.stderr.write(chalk.green(`${secretCount} injected\n`));
              } catch {
                process.stderr.write(
                  chalk.yellow("(could not fetch secrets)\n"),
                );
              }
            }
            // If no link and no --app: run without secrets (no error)
          }

          // Build the child argv — commander gives us the full args array
          const [cmd, ...args] = commandParts;
          if (!cmd) {
            throw new UserError("Command resolved to an empty string.");
          }

          const mergedEnv: NodeJS.ProcessEnv = {
            ...process.env,
            ...injectedEnv,
          };

          const child = spawn(cmd, args, {
            cwd,
            env: mergedEnv,
            stdio: "inherit",
            shell: true,
          });

          // Forward signals so the child receives Ctrl+C etc.
          const forward = (signal: NodeJS.Signals): void => {
            child.kill(signal);
          };
          const sigint = (): void => forward("SIGINT");
          const sigterm = (): void => forward("SIGTERM");
          process.on("SIGINT", sigint);
          process.on("SIGTERM", sigterm);

          await new Promise<void>((resolve) => {
            child.on("close", (code) => {
              process.off("SIGINT", sigint);
              process.off("SIGTERM", sigterm);
              resolve();
              // Mirror the child's exit code exactly
              process.exit(code ?? 0);
            });
          });
        } catch (err) {
          handleError(err);
        }
      },
    );
}
