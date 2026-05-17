import { spawn } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { handleError } from "./util.js";
import { loadLocalLink } from "./link.js";
import {
  detectFramework,
  FRAMEWORK_LABELS,
  type Framework,
} from "../framework-detector.js";
import type { EnvVarPreview } from "../types.js";

// ── dev command defaults per framework ───────────────────────────────────────

const DEV_COMMANDS: Record<Framework, string> = {
  nextjs: "next dev",
  sveltekit: "vite dev",
  "vite-react": "vite",
  phoenix: "mix phx.server",
  django: "python manage.py runserver",
  flask: "flask run",
  rails: "bin/rails server",
  go: "go run .",
  rust: "cargo run",
  static: "npx serve .",
};

const DEV_PORTS: Record<Framework, number> = {
  nextjs: 4000,
  sveltekit: 5173,
  "vite-react": 5173,
  phoenix: 4000,
  django: 8000,
  flask: 5000,
  rails: 3000,
  go: 8080,
  rust: 8080,
  static: 3000,
};

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

  // Fetch tenant secrets — the list response includes host_id, which is
  // required to build the reveal path: POST /opencomputers/hosts/:host_id/secrets/:secret_id/reveal
  const tenantSecrets = await client
    .apiGet<{
      data: Array<{ id: string; name: string; host_id: string | null }>;
    }>("/api/v1/opencomputers/secrets")
    .catch(() => ({
      data: [] as Array<{ id: string; name: string; host_id: string | null }>,
    }));

  const secretByName = new Map(tenantSecrets.data.map((s) => [s.name, s]));

  const env: Record<string, string> = {};

  for (const preview of previews) {
    const secret = secretByName.get(preview.name);
    // Only host-scoped secrets have a reveal path (host_id is non-null)
    if (secret?.host_id) {
      try {
        const revealed = await client.apiPost<{ value?: string }>(
          `/api/v1/opencomputers/hosts/${encodeURIComponent(secret.host_id)}/secrets/${encodeURIComponent(secret.id)}/reveal`,
        );
        env[preview.name] = revealed.value ?? preview.preview;
        continue;
      } catch {
        // Fall through to preview
      }
    }
    env[preview.name] = preview.preview;
  }

  return env;
}

// ── spawn helpers ─────────────────────────────────────────────────────────────

/**
 * Inject PORT into the command string when the framework accepts it as an
 * argument (Next.js uses `--port`, most others read the PORT env var).
 */
function buildDevCommand(
  baseCommand: string,
  framework: Framework | null,
  port: number,
): string {
  if (framework === "nextjs") {
    return `${baseCommand} --port ${port}`;
  }
  // All others pick up PORT via env — no arg injection needed
  return baseCommand;
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("dev")
    .description(
      "Start local dev server with MIOSA secrets injected as env vars",
    )
    .option("--port <port>", "Override default dev server port", (v) =>
      parseInt(v, 10),
    )
    .option("--command <cmd>", "Override the auto-detected dev command")
    .option("--app <id>", "Deployment ID (overrides .miosa.json)")
    .addHelpText(
      "after",
      `
Examples:
  miosa dev                        Auto-detect framework, inject secrets, start
  miosa dev --port 3000            Override the port
  miosa dev --command "node server.js"   Use a custom dev command
  miosa dev --app <id>             Use secrets from a specific deployment
`,
    )
    .action(async (opts: { port?: number; command?: string; app?: string }) => {
      try {
        const cwd = process.cwd();

        // ── Resolve deployment ─────────────────────────────────────────
        let deploymentId: string | null = null;
        let projectName = "project";

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

        // ── Detect framework ───────────────────────────────────────────
        const detection = detectFramework(cwd);
        const framework = detection?.framework ?? null;
        const frameworkLabel = framework
          ? (FRAMEWORK_LABELS[framework] ?? framework)
          : null;

        if (frameworkLabel) {
          console.log(chalk.dim(`Detected: ${chalk.white(frameworkLabel)}`));
        }

        // ── Resolve port ───────────────────────────────────────────────
        const port =
          opts.port ?? (framework ? DEV_PORTS[framework] : null) ?? 3000;

        // ── Fetch secrets ──────────────────────────────────────────────
        let injectedEnv: Record<string, string> = {};
        let secretCount = 0;

        if (deploymentId) {
          const config = loadConfig();
          const client = new MiosaClient(config);

          process.stdout.write(
            chalk.dim(`Injecting secrets from ${chalk.white(projectName)}...`),
          );

          try {
            injectedEnv = await fetchEnvVars(client, deploymentId);
            secretCount = Object.keys(injectedEnv).length;
            process.stdout.write(
              ` ${chalk.green(String(secretCount))} injected\n`,
            );
          } catch {
            process.stdout.write(chalk.yellow(" (could not fetch secrets)\n"));
          }
        } else {
          console.log(
            chalk.dim(
              "No .miosa.json found — starting without injected secrets. Run `miosa link` to connect.",
            ),
          );
        }

        // ── Resolve dev command ────────────────────────────────────────
        let devCommand: string;

        if (opts.command) {
          devCommand = opts.command;
        } else if (framework) {
          devCommand = buildDevCommand(
            DEV_COMMANDS[framework],
            framework,
            port,
          );
        } else {
          throw new UserError(
            "Could not detect a framework. Pass --command to specify the dev command.",
            "Example: miosa dev --command 'npm run dev'",
          );
        }

        console.log(
          chalk.dim(`Starting dev server: ${chalk.white(devCommand)}`),
        );
        console.log();
        console.log(chalk.bold("Ready:"));
        console.log(
          `  ${chalk.bold("Local:")}    ${chalk.cyan(`http://localhost:${port}`)}`,
        );
        if (secretCount > 0) {
          console.log(
            `  ${chalk.bold("Secrets:")}  ${secretCount} injected from ${projectName}`,
          );
        }
        console.log();

        // ── Spawn child process ────────────────────────────────────────
        const mergedEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...injectedEnv,
          PORT: String(port),
        };

        // Split the command string into argv — honour quoted segments
        const [cmd, ...args] = shellSplit(devCommand);
        if (!cmd) {
          throw new UserError("Dev command resolved to an empty string.");
        }

        const child = spawn(cmd, args, {
          cwd,
          env: mergedEnv,
          stdio: "inherit",
          shell: true,
        });

        // Graceful shutdown
        const shutdown = (): void => {
          child.kill("SIGTERM");
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        await new Promise<void>((resolve) => {
          child.on("close", (code) => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
            resolve();
            process.exit(code ?? 0);
          });
        });
      } catch (err) {
        handleError(err);
      }
    });
}

// ── shell tokeniser ───────────────────────────────────────────────────────────

/**
 * Minimal POSIX-style shell word splitter.
 * Handles single-quoted, double-quoted, and unquoted segments.
 * Sufficient for the controlled command strings this command generates.
 */
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === "'") {
      // Single-quoted: take everything literally until closing '
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i++];
      }
      i++; // skip closing '
    } else if (ch === '"') {
      // Double-quoted: honour backslash escapes for " and \
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          i++;
          current += input[i++];
        } else {
          current += input[i++];
        }
      }
      i++; // skip closing "
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
