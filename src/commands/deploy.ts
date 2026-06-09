import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError, isJsonMode } from "./util.js";
import { spin } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import {
  errorEnvelope,
  hintBlock,
  icon,
  kvPanel,
  printBanner,
  printElapsed,
  formatDuration,
} from "../ui/render.js";
import { formatBytes } from "../ui/progress.js";
import {
  detectFramework,
  FRAMEWORK_LABELS,
  type Framework,
} from "../framework-detector.js";
import { UserError } from "../errors.js";
import type {
  Deployment,
  DeploymentBuild,
  DeploymentId,
  MiosaProjectConfig,
} from "../types.js";
import { toDeploymentId } from "../types.js";

// ── .miosa.json helpers ───────────────────────────────────────────────────────

const PROJECT_CONFIG_FILE = ".miosa.json";

function loadProjectConfig(dir: string): MiosaProjectConfig | null {
  const p = path.join(dir, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as MiosaProjectConfig;
  } catch {
    return null;
  }
}

function saveProjectConfig(dir: string, cfg: MiosaProjectConfig): void {
  const p = path.join(dir, PROJECT_CONFIG_FILE);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

// ── Git helpers ───────────────────────────────────────────────────────────────

interface GitInfo {
  repoUrl: string;
  currentBranch: string;
}

function getGitInfo(dir: string): GitInfo {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "ignore" });
  } catch {
    throw new UserError(
      "Not a git repository.",
      "Run `git init && git remote add origin <url>` first, then `miosa deploy`.",
    );
  }

  let repoUrl: string;
  try {
    repoUrl = execSync("git remote get-url origin", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new UserError(
      "No git remote named 'origin' found.",
      "Add one with: git remote add origin https://github.com/you/your-repo",
    );
  }

  // Normalize SSH remote → HTTPS
  if (repoUrl.startsWith("git@github.com:")) {
    repoUrl = repoUrl
      .replace("git@github.com:", "https://github.com/")
      .replace(/\.git$/, "");
  }
  repoUrl = repoUrl.replace(/\.git$/, "");

  let currentBranch = "main";
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  } catch {
    // default to main
  }

  return { repoUrl, currentBranch };
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function deploymentUrl(
  deployment: Pick<Deployment, "slug" | "public_url" | "auto_subdomain">,
  tenantSlug?: string | null,
): string | null {
  if (deployment.public_url) return deployment.public_url;
  if (deployment.auto_subdomain) return deployment.auto_subdomain;
  if (tenantSlug && deployment.slug) {
    return `https://${deployment.slug}.${tenantSlug}.miosa.app`;
  }
  return null;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function deploymentProduct(
  deployment: Pick<Deployment, "deployment_product" | "metadata">,
): string {
  const metadataProduct = deployment.metadata?.["deployment_product"];
  if (typeof deployment.deployment_product === "string") {
    return deployment.deployment_product;
  }
  if (typeof metadataProduct === "string") return metadataProduct;
  return "miosa_deploy";
}

function productLabel(product: string): string {
  return product === "docker_deploy" ? "Docker Deploy" : "MIOSA Deploy";
}

// ── Deployment ID resolution ──────────────────────────────────────────────────

function resolveDeploymentId(
  idArg: string | undefined,
  cwd: string,
): DeploymentId {
  if (idArg) return toDeploymentId(idArg);
  const proj = loadProjectConfig(cwd);
  if (proj) return proj.deploymentId;
  throw new UserError(
    "No deployment ID provided and no .miosa.json found in current directory.",
    "Pass a deployment ID or run from a project with .miosa.json",
  );
}

// ── Log stream renderer ───────────────────────────────────────────────────────

async function streamLogs(
  client: MiosaClient,
  deploymentId: DeploymentId,
): Promise<"success" | "failure"> {
  const res = await client.streamDeploymentLogs(deploymentId);
  let lastState: "success" | "failure" = "success";

  for await (const event of parseSse(res.body)) {
    switch (event.type) {
      case "stdout": {
        process.stdout.write(chalk.dim("  ") + event.data);
        break;
      }
      case "stderr": {
        process.stderr.write(chalk.red("  ") + event.data);
        break;
      }
      case "error": {
        console.error(chalk.red(`  [error] ${event.message}`));
        lastState = "failure";
        break;
      }
      case "done": {
        // done event may carry build state
        if (event.result && typeof event.result === "object") {
          const r = event.result as Record<string, unknown>;
          if (r["state"] === "failed") lastState = "failure";
        }
        return lastState;
      }
      case "unknown": {
        // Try to parse log_line events from the deployment SSE format
        // event: log_line  data: {"stream":"stdout","line":"...","ts":"..."}
        try {
          const parsed = JSON.parse(event.raw) as Record<string, unknown>;
          if (typeof parsed["line"] === "string") {
            const stream = parsed["stream"] ?? "stdout";
            const line = parsed["line"] as string;
            if (stream === "stderr") {
              process.stderr.write(chalk.red("  ") + line + "\n");
            } else {
              process.stdout.write(chalk.dim("  ") + line + "\n");
            }
          }
        } catch {
          // ignore unparseable frames
        }
        break;
      }
      default:
        break;
    }
  }

  return lastState;
}

// ── Sub-command helpers ───────────────────────────────────────────────────────

function fmtBuildState(state: DeploymentBuild["state"]): string {
  switch (state) {
    case "succeeded":
      return chalk.green(state);
    case "failed":
      return chalk.red(state);
    case "building":
      return chalk.yellow(state);
    case "queued":
      return chalk.dim(state);
    case "cancelled":
      return chalk.dim(state);
  }
}

function fmtDeployState(state: Deployment["state"]): string {
  switch (state) {
    case "running":
      return chalk.green(state);
    case "failed":
      return chalk.red(state);
    case "building":
      return chalk.yellow(state);
    case "stopped":
      return chalk.dim(state);
    case "pending":
      return chalk.dim(state);
  }
}

function unwrapMetrics(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && "data" in raw) {
    const data = (raw as Record<string, unknown>)["data"];
    if (data && typeof data === "object") return data as Record<string, unknown>;
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function metricCurrent(raw: unknown): Record<string, unknown> {
  const root = unwrapMetrics(raw);
  const current = root["current"];
  return current && typeof current === "object"
    ? (current as Record<string, unknown>)
    : {};
}

function renderDeploymentMetrics(raw: unknown): void {
  const root = unwrapMetrics(raw);
  const current = metricCurrent(raw);
  const instances =
    current["runtime_instances"] && typeof current["runtime_instances"] === "object"
      ? (current["runtime_instances"] as Record<string, unknown>)
      : {};
  const usage =
    current["usage"] && typeof current["usage"] === "object"
      ? (current["usage"] as Record<string, unknown>)
      : {};

  printBanner({ subtitle: "Deployment metrics" });
  console.log(
    kvPanel([
      { label: "deployment_id", value: String(root["deployment_id"] ?? root["resource_id"] ?? "-") },
      { label: "window", value: String(root["window"] ?? "1h") },
      { label: "state", value: formatMetricState(current["state"]) },
      {
        label: "runtime_instances",
        value: `${formatMetricValue(instances["active"])} active / ${formatMetricValue(instances["total"])} total`,
      },
      { label: "healthy", value: formatMetricValue(instances["healthy"]) },
      { label: "unhealthy", value: formatMetricValue(instances["unhealthy"]) },
      { label: "errors", value: formatMetricValue(instances["error"]) },
      { label: "restarts", value: formatMetricValue(instances["restarts"]) },
      { label: "cpu_limit", value: formatMillicores(current["cpu_limit_millicores"]) },
      { label: "memory_limit", value: formatMb(current["memory_limit_mb"]) },
      { label: "runtime", value: formatSeconds(usage["runtime_sec"]) },
      { label: "cost_cents", value: formatMetricValue(usage["cost_cents"]) },
      { label: "last_health_check", value: formatMetricValue(current["last_health_check_at"]) },
      { label: "last_heartbeat", value: formatMetricValue(current["last_heartbeat_at"]) },
    ]),
  );
}

function formatMetricState(value: unknown): string {
  const state = String(value ?? "unknown");
  if (["running", "active", "healthy", "ready"].includes(state)) {
    return chalk.green(state);
  }
  if (["provisioning", "starting", "building", "pending"].includes(state)) {
    return chalk.yellow(state);
  }
  if (["failed", "error", "unhealthy"].includes(state)) {
    return chalk.red(state);
  }
  return state;
}

function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return chalk.dim("-");
  return String(value);
}

function formatMb(value: unknown): string {
  if (typeof value !== "number") return formatMetricValue(value);
  return formatBytes(value * 1024 * 1024);
}

function formatMillicores(value: unknown): string {
  if (typeof value !== "number") return formatMetricValue(value);
  return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 2)} vCPU`;
}

function formatSeconds(value: unknown): string {
  if (typeof value !== "number") return formatMetricValue(value);
  return formatDuration(value * 1000);
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const deploy = program
    .command("deploy")
    .alias("launch")
    .description("Deploy a GitHub repo to MIOSA Deploy")
    .option(
      "--docker-deploy",
      "Create the deployment on this workspace's dedicated Docker Deploy runtime",
    )
    .addHelpText(
      "after",
      `
Examples:
  miosa deploy                       Deploy current directory (auto-detects framework)
  miosa deploy --docker-deploy       Deploy current directory to Docker Deploy
  miosa deploy list                  List all deployments
  miosa deploy logs                  Tail build logs for this project
  miosa deploy redeploy              Trigger a new build
  miosa deploy env set NODE_ENV=production
  miosa deploy env list
  miosa deploy domain add example.com
  miosa deploy destroy               Tear down this deployment
`,
    )
    .action(async (opts: { dockerDeploy?: boolean }) => {
      // Default action: interactive deploy flow
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);

        // ── Check for existing .miosa.json first (skip git for redeploys) ──
        let projectCfg = loadProjectConfig(cwd);
        let deploymentId: DeploymentId;

        if (projectCfg) {
          // ── Re-deploy from existing .miosa.json ──────────────────────
          console.log();
          console.log(
            chalk.dim("  Found .miosa.json — redeploying existing deployment"),
          );
          console.log(
            `  ${chalk.bold("Project")}   ${projectCfg.name} (${projectCfg.framework})`,
          );
          console.log(`  ${chalk.bold("Branch")}    ${projectCfg.branch}`);
          console.log();

          deploymentId = projectCfg.deploymentId;

          const buildSpinner = spin("Queuing build...");
          try {
            await client.redeployDeployment(deploymentId);
            buildSpinner.succeed("Build queued");
          } catch (err) {
            buildSpinner.fail("Failed to queue build");
            handleError(err);
          }
        } else {
          // ── First deploy: verify git repo + remote, then detect ───────
          const { repoUrl, currentBranch } = getGitInfo(cwd);

          console.log();

          const detection = detectFramework(cwd);

          let framework = "unknown";
          let buildCommand = "npm run build";
          let runCommand = "npm start";

          if (detection) {
            const label =
              FRAMEWORK_LABELS[detection.framework as Framework] ??
              detection.framework;
            console.log(
              `  Detected: ${chalk.cyan(label)} (confidence ${detection.confidence}%)`,
            );
            framework = detection.framework;
            buildCommand = detection.buildCommand;
            runCommand = detection.runCommand;
          } else {
            console.log(
              chalk.yellow(
                "  Could not auto-detect framework. You can set build/run commands manually.",
              ),
            );
          }

          console.log(`  Repo:     ${chalk.dim(repoUrl)}`);
          console.log(`  Branch:   ${chalk.dim(currentBranch)}`);
          console.log();

          // ── Interactive prompts ──────────────────────────────────────
          const { default: inquirer } = await import("inquirer");

          const projectName = path.basename(cwd).replace(/[^a-z0-9-]/gi, "-");

          const answers = await inquirer.prompt<{
            name: string;
            branch: string;
            buildCommand: string;
            runCommand: string;
            confirm: boolean;
          }>([
            {
              type: "input",
              name: "name",
              message: "Deployment name:",
              default: projectName,
              validate: (v: string) =>
                v.length > 0 ? true : "Name is required",
            },
            {
              type: "input",
              name: "branch",
              message: "Branch to deploy:",
              default: currentBranch,
            },
            {
              type: "input",
              name: "buildCommand",
              message: "Build command:",
              default: buildCommand,
            },
            {
              type: "input",
              name: "runCommand",
              message: "Run command:",
              default: runCommand,
            },
            {
              type: "confirm",
              name: "confirm",
              message: "Create deployment?",
              default: true,
            },
          ]);

          if (!answers.confirm) {
            console.log(chalk.dim("  Cancelled."));
            process.exit(0);
          }

          // ── Step 3: POST /api/v1/deployments ─────────────────────────
          const createSpinner = spin(
            `Creating deployment "${answers.name}"...`,
          );
          let webhookSecret: string;
          let deployment: Deployment;

          try {
            const metadata = opts.dockerDeploy
              ? { deployment_product: "docker_deploy" }
              : undefined;
            const result = await client.createDeployment({
              name: answers.name,
              repo_url: repoUrl,
              branch: answers.branch,
              build_command: answers.buildCommand || undefined,
              run_command: answers.runCommand || undefined,
              auto_deploy: true,
              metadata,
            });
            deployment = result.data;
            webhookSecret = result.webhook_secret;
            createSpinner.succeed(
              `${productLabel(deploymentProduct(deployment))} deployment "${deployment.name}" created (slug: ${deployment.slug})`,
            );
          } catch (err) {
            createSpinner.fail("Failed to create deployment");
            handleError(err);
          }

          deploymentId = deployment.id;
          framework = framework !== "unknown" ? framework : "unknown";

          // ── Step 4: Save .miosa.json ──────────────────────────────────
          projectCfg = {
            version: 1,
            deploymentId: deployment.id,
            name: deployment.name,
            framework,
            buildCommand: answers.buildCommand,
            runCommand: answers.runCommand,
            branch: answers.branch,
          };
          saveProjectConfig(cwd, projectCfg);
          console.log(chalk.dim(`  Saved .miosa.json`));

          // ── Step 4b: Print webhook secret (one-time) ─────────────────
          console.log();
          console.log(chalk.bold.yellow("  ACTION REQUIRED — GitHub Webhook"));
          console.log(
            chalk.dim(
              "  The webhook secret below is shown ONCE. Store it now.",
            ),
          );
          console.log();
          console.log(
            `  ${chalk.bold("Webhook URL:")}   https://api.miosa.ai/api/v1/integrations/github/webhook`,
          );
          console.log(`  ${chalk.bold("Content type:")}  application/json`);
          console.log(
            `  ${chalk.bold("Secret:")}        ${chalk.green(webhookSecret)}`,
          );
          console.log(`  ${chalk.bold("Events:")}        push`);
          console.log();
          console.log(
            chalk.dim("  Add this at: " + repoUrl + "/settings/hooks/new"),
          );
          console.log();

          // ── Step 5: Trigger initial build ─────────────────────────────
          const buildSpinner = spin("Queuing initial build...");
          try {
            await client.redeployDeployment(deploymentId);
            buildSpinner.succeed("Initial build queued");
          } catch (err) {
            buildSpinner.fail("Failed to queue build");
            handleError(err);
          }
        }

        // ── Step 6: Stream build logs ─────────────────────────────────────
        console.log();
        console.log(chalk.bold("  Build log:"));
        console.log(chalk.dim("  " + "─".repeat(60)));

        const buildResult = await streamLogs(client, deploymentId);

        console.log(chalk.dim("  " + "─".repeat(60)));
        console.log();

        // ── Step 7: Final status ──────────────────────────────────────────
        if (buildResult === "success") {
          // Fetch the deployment to get the slug + tenant slug
          const spinner = spin("Fetching deployment info...");
          try {
            const dep = await client.getDeployment(deploymentId);
            const tenant = await client.getTenant();
            spinner.stop();

            const url = deploymentUrl(dep, tenant.slug);
            console.log(chalk.green("  Deployed"));
            console.log();
            console.log(`  ${chalk.bold("URL:")}    ${chalk.cyan(url ?? "—")}`);
            console.log(
              `  ${chalk.bold("Type:")}   ${productLabel(deploymentProduct(dep))}`,
            );
            if (dep.docker_deploy_host_id) {
              console.log(
                `  ${chalk.bold("Host:")}   ${chalk.dim(dep.docker_deploy_host_id)}`,
              );
            }
            console.log();
            console.log(chalk.dim("  Next steps:"));
            console.log(
              chalk.dim(`    miosa deploy logs          — tail logs`),
            );
            console.log(
              chalk.dim(
                `    miosa deploy domain add example.com   — add custom domain`,
              ),
            );
            console.log(
              chalk.dim(
                `    miosa deploy env set KEY=VALUE         — set env var`,
              ),
            );
          } catch {
            spinner.stop();
            console.log(chalk.green("  Deployed"));
          }
        } else {
          console.log(chalk.red("  Build failed."));
          console.log();
          console.log(chalk.dim("  View full logs: miosa deploy logs"));
          console.log(
            chalk.dim(
              `  Dashboard: https://app.miosa.ai/deploy/${deploymentId}`,
            ),
          );
          process.exit(1);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy list ─────────────────────────────────────────────────────────────

  deploy
    .command("list")
    .description("List all deployments for this tenant")
    .option("--state <state>", "Filter by deployment state")
    .option("--workspace <id>", "Filter by workspace ID")
    .option(
      "--limit <n>",
      "Maximum number of deployments to return",
      parsePositiveInteger,
    )
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        state?: string;
        workspace?: string;
        limit?: number;
        json?: boolean;
      }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const json = isJsonMode(opts);
          const spinner = json ? null : spin("Fetching deployments...");
          const deployments = await client.listDeployments({
            state: opts.state,
            workspace: opts.workspace,
            limit: opts.limit,
          });
          spinner?.stop();

          if (json) {
            console.log(JSON.stringify(deployments, null, 2));
            return;
          }

          const n = deployments.length;
          console.log();
          console.log(
            `  ${icon.info}  ${chalk.bold(String(n))} ${chalk.dim(n === 1 ? "deployment" : "deployment(s)")}`,
          );
          console.log();

          if (n === 0) {
            console.log(
              kvPanel([{ label: "Deployments", value: chalk.dim("none yet") }]),
            );
            console.log();
            console.log(
              hintBlock("Try", [
                "miosa deploy  # deploy a project from the current directory",
              ]),
            );
            console.log();
            return;
          }

          renderTable(deployments, [
            { header: "ID", key: (d) => d.id.slice(0, 8), width: 10 },
            { header: "NAME", key: "name", width: 24 },
            {
              header: "TYPE",
              key: (d) => productLabel(deploymentProduct(d)),
              width: 14,
            },
            { header: "SLUG", key: "slug", width: 24 },
            { header: "BRANCH", key: "branch", width: 12 },
            {
              header: "STATE",
              key: (d) => fmtDeployState(d.state),
              width: 10,
            },
            {
              header: "UPDATED",
              key: (d) => new Date(d.updated_at).toLocaleString(),
              width: 20,
            },
          ]);
          console.log();
          console.log(
            hintBlock("Try", [
              "miosa deploy show <id>",
              "miosa deploy redeploy <id>  # redeploy",
              "miosa deploy rollback <id>",
            ]),
          );
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── deploy show ─────────────────────────────────────────────────────────────

  deploy
    .command("show <id>")
    .description("Show details for a single deployment")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = toDeploymentId(id);

        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching deployment...");
        const dep = await client.getDeployment(deploymentId);
        spinner?.stop();

        if (json) {
          console.log(JSON.stringify(dep, null, 2));
          return;
        }

        const truncate = (s: string | null, max: number): string => {
          if (!s) return chalk.dim("—");
          return s.length > max ? s.slice(0, max - 1) + "…" : s;
        };

        const colorizeState = (state: Deployment["state"]): string => {
          switch (state) {
            case "running":
              return chalk.green(state);
            case "building":
              return chalk.yellow(state);
            case "failed":
              return chalk.red(state);
            default:
              return chalk.dim(state);
          }
        };

        const tenant = await client.getTenant().catch(() => null);
        const publicUrl = deploymentUrl(dep, tenant?.slug) ?? chalk.dim("—");

        printBanner({ subtitle: "Deployment" });
        console.log(
          kvPanel([
            { label: "id", value: chalk.dim(dep.id) },
            { label: "name", value: chalk.bold(dep.name) },
            { label: "type", value: productLabel(deploymentProduct(dep)) },
            { label: "state", value: colorizeState(dep.state) },
            {
              label: "docker_deploy_host_id",
              value: dep.docker_deploy_host_id
                ? chalk.dim(dep.docker_deploy_host_id)
                : chalk.dim("—"),
            },
            {
              label: "current_build_id",
              value: dep.current_build_id
                ? chalk.dim(dep.current_build_id)
                : chalk.dim("—"),
            },
            { label: "repo_url", value: chalk.cyan(dep.repo_url) },
            { label: "branch", value: dep.branch },
            {
              label: "build_command",
              value: truncate(dep.build_command, 60),
            },
            { label: "run_command", value: truncate(dep.run_command, 60) },
            {
              label: "created_at",
              value: chalk.dim(new Date(dep.created_at).toLocaleString()),
            },
            { label: "public_url", value: chalk.cyan(publicUrl) },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Try", [
            "miosa deploy redeploy <id>  # redeploy",
            "miosa logs <id>  # tail build/runtime logs",
            "miosa deploy rollback <id>",
          ]),
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy metrics ──────────────────────────────────────────────────────────

  deploy
    .command("metrics [id]")
    .description("Show deployment runtime instance, usage, and health metrics")
    .option("--window <window>", "Metrics window: 1h, 24h, or 7d", "1h")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string | undefined,
        opts: { window: string; json?: boolean },
      ) => {
        try {
          const cwd = process.cwd();
          const config = loadConfig();
          const client = new MiosaClient(config);
          const deploymentId = resolveDeploymentId(id, cwd);
          const json = isJsonMode(opts);
          const spinner = json ? null : spin("Fetching deployment metrics...");
          const metrics = await client.apiGet<unknown>(
            `/api/v1/deployments/${encodeURIComponent(deploymentId)}/metrics?window=${encodeURIComponent(opts.window)}`,
          );
          spinner?.stop();

          if (json) {
            console.log(JSON.stringify(metrics, null, 2));
            return;
          }

          renderDeploymentMetrics(metrics);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── deploy logs ─────────────────────────────────────────────────────────────

  deploy
    .command("logs [id]")
    .description(
      "Tail live build logs for a deployment (auto-detected from .miosa.json)",
    )
    .action(async (id?: string) => {
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = resolveDeploymentId(id, cwd);

        console.log(chalk.dim(`  Streaming logs for ${deploymentId}...`));
        console.log(chalk.dim("  " + "─".repeat(60)));

        await streamLogs(client, deploymentId);

        console.log(chalk.dim("  " + "─".repeat(60)));
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy redeploy ──────────────────────────────────────────────────────────

  deploy
    .command("redeploy [id]")
    .description("Trigger a manual rebuild (auto-detected from .miosa.json)")
    .option("--no-follow", "Queue the build without tailing logs")
    .action(async (id?: string, opts?: { follow: boolean }) => {
      const actionStart = Date.now();
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = resolveDeploymentId(id, cwd);

        const spinner = spin("Queuing build...");
        let build: DeploymentBuild;
        try {
          build = await client.redeployDeployment(deploymentId);
          spinner.stop();
        } catch (err) {
          spinner.stop();
          console.log();
          console.log(
            errorEnvelope({
              title: "Redeploy failed",
              body: err instanceof Error ? err.message : String(err),
              suggest: [
                "miosa deploy show <id>  # check deployment state",
                "miosa deploy list       # list all deployments",
              ],
              withDebugHint: true,
            }),
          );
          console.log();
          process.exit(4);
        }

        printBanner({ subtitle: "Redeploy queued" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "deployment_id",
              value: chalk.dim(deploymentId),
            },
            { label: "new_build_id", value: chalk.dim(build.id) },
            { label: "state", value: chalk.yellow("queued") },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Watch", [
            `miosa logs ${deploymentId} --follow`,
            `miosa deploy show ${deploymentId}`,
          ]),
        );
        printElapsed(formatDuration(Date.now() - actionStart));

        if (opts?.follow !== false) {
          console.log();
          console.log(chalk.bold("  Build log:"));
          console.log(chalk.dim("  " + "─".repeat(60)));
          await streamLogs(client, deploymentId);
          console.log(chalk.dim("  " + "─".repeat(60)));
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy env ───────────────────────────────────────────────────────────────

  const envCmd = deploy
    .command("env")
    .description("Manage environment variables for a deployment");

  envCmd
    .command("set <pairs...>")
    .description("Set one or more env vars (KEY=VALUE)")
    .option("--id <id>", "Deployment ID (overrides .miosa.json)")
    .action(async (pairs: string[], opts: { id?: string }) => {
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = resolveDeploymentId(opts.id, cwd);

        const env: Record<string, string> = {};
        for (const pair of pairs) {
          const eq = pair.indexOf("=");
          if (eq === -1) {
            env[pair] = "";
          } else {
            env[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
        }

        const spinner = spin("Setting env vars...");
        const vars = await client.setDeploymentEnv(deploymentId, env);
        spinner.succeed(`Set ${vars.length} env var(s)`);

        for (const v of vars) {
          console.log(`  ${chalk.bold(v.name)}  ${chalk.dim(v.preview)}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  envCmd
    .command("list [id]")
    .description("List env var names and masked previews")
    .action(async (id?: string) => {
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = resolveDeploymentId(id, cwd);

        const spinner = spin("Fetching env vars...");
        const vars = await client.getDeploymentEnv(deploymentId);
        spinner.stop();

        if (vars.length === 0) {
          console.log(chalk.dim("  No env vars set."));
          return;
        }

        renderTable(vars, [
          { header: "NAME", key: "name", width: 32 },
          { header: "VALUE", key: (v) => chalk.dim(v.preview), width: 20 },
          {
            header: "UPDATED",
            key: (v) => new Date(v.updated_at).toLocaleString(),
            width: 20,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy domain ────────────────────────────────────────────────────────────

  const domainCmd = deploy
    .command("domain")
    .description("Manage custom domains for a deployment");

  domainCmd
    .command("add <domain> [id]")
    .description("Add a custom domain to a deployment")
    .action(async (domain: string, id?: string) => {
      try {
        const cwd = process.cwd();
        resolveDeploymentId(id, cwd); // validate — actual domain API is v2

        // Domain management endpoints are in the next sprint.
        // Point the user to the dashboard in the interim.
        console.log();
        console.log(
          chalk.yellow(
            `  Custom domain management is not yet available via the CLI.`,
          ),
        );
        console.log(
          chalk.dim(`  Configure "${domain}" at: https://app.miosa.ai/deploy`),
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // ── deploy destroy ───────────────────────────────────────────────────────────

  deploy
    .command("destroy [id]")
    .description("Permanently delete a deployment and all build history")
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (id?: string, opts?: { force?: boolean }) => {
      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const deploymentId = resolveDeploymentId(id, cwd);

        if (!opts?.force) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: chalk.red(
                `Destroy deployment ${deploymentId.slice(0, 8)}? This is irreversible.`,
              ),
              default: false,
            },
          ]);
          if (!ok) {
            console.log(chalk.dim("  Cancelled."));
            process.exit(0);
          }
        }

        const spinner = spin("Destroying deployment...");
        await client.deleteDeployment(deploymentId);
        spinner.succeed("Deployment destroyed");

        // Remove local .miosa.json if it references this deployment
        const proj = loadProjectConfig(cwd);
        if (proj?.deploymentId === deploymentId) {
          fs.unlinkSync(path.join(cwd, PROJECT_CONFIG_FILE));
          console.log(chalk.dim("  Removed .miosa.json"));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
