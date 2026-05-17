/**
 * `miosa up` — smart context-aware launch command.
 *
 * Detects what you're working with and does the right thing:
 *   .miosa.json or miosa.json  → redeploy existing project
 *   Dockerfile                 → build and deploy as container (not yet live — falls through to deploy)
 *   package.json / mix.exs / requirements.txt → detect framework, deploy
 *   --computer flag            → create a desktop computer
 *   --sandbox flag             → create a sandbox
 *   nothing                   → interactive mode to pick an action
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";

import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError } from "./util.js";
import {
  detectFramework,
  FRAMEWORK_LABELS,
  type Framework,
} from "../framework-detector.js";
import { UserError } from "../errors.js";
import type { Deployment, DeploymentId, MiosaProjectConfig } from "../types.js";
import { toDeploymentId } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type UpMode =
  | "redeploy"
  | "deploy-new"
  | "computer"
  | "sandbox"
  | "interactive";

interface UpOptions {
  yes: boolean;
  json: boolean;
  name?: string;
  computer: boolean;
  sandbox: boolean;
  // computer-mode
  os: string;
  size: string;
  // sandbox-mode
  image: string;
}

// ── .miosa.json helpers ───────────────────────────────────────────────────────

const PROJECT_CONFIG_FILES = [".miosa.json", "miosa.json"] as const;

function loadProjectConfig(dir: string): MiosaProjectConfig | null {
  for (const filename of PROJECT_CONFIG_FILES) {
    const p = path.join(dir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as MiosaProjectConfig;
    } catch {
      return null;
    }
  }
  return null;
}

function saveProjectConfig(dir: string, cfg: MiosaProjectConfig): void {
  const p = path.join(dir, ".miosa.json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

// ── Signals ───────────────────────────────────────────────────────────────────

/**
 * Write a single status line. In JSON mode output nothing (caller handles JSON).
 * Uses \r to overwrite the same line for streaming progress feel.
 */
function line(msg: string, opts: Pick<UpOptions, "json">): void {
  if (opts.json) return;
  process.stdout.write(msg + "\n");
}

function lineProgress(msg: string, opts: Pick<UpOptions, "json">): void {
  if (opts.json) return;
  process.stdout.write(`  ${msg}\n`);
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
      "Run `git init && git remote add origin <url>` first.",
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
      "Add one with: git remote add origin https://github.com/you/repo",
    );
  }

  // Normalize SSH → HTTPS
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
    // default
  }

  return { repoUrl, currentBranch };
}

// ── Deploy log streaming ──────────────────────────────────────────────────────

async function streamDeployLogs(
  client: MiosaClient,
  deploymentId: DeploymentId,
  opts: Pick<UpOptions, "json">,
): Promise<"success" | "failure"> {
  const res = await client.streamDeploymentLogs(deploymentId);
  let lastState: "success" | "failure" = "success";

  for await (const event of parseSse(res.body)) {
    switch (event.type) {
      case "stdout":
        if (!opts.json) process.stdout.write(chalk.dim("  ") + event.data);
        break;
      case "stderr":
        if (!opts.json) process.stderr.write(chalk.red("  ") + event.data);
        break;
      case "error":
        if (!opts.json) console.error(chalk.red(`  [error] ${event.message}`));
        lastState = "failure";
        break;
      case "done": {
        if (event.result && typeof event.result === "object") {
          const r = event.result as Record<string, unknown>;
          if (r["state"] === "failed") lastState = "failure";
        }
        return lastState;
      }
      case "unknown": {
        try {
          const parsed = JSON.parse(event.raw) as Record<string, unknown>;
          if (typeof parsed["line"] === "string" && !opts.json) {
            const stream = parsed["stream"] ?? "stdout";
            const logLine = parsed["line"] as string;
            if (stream === "stderr") {
              process.stderr.write(chalk.red("  ") + logLine + "\n");
            } else {
              process.stdout.write(chalk.dim("  ") + logLine + "\n");
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

// ── Mode: redeploy existing .miosa.json ──────────────────────────────────────

async function runRedeploy(
  client: MiosaClient,
  projectCfg: MiosaProjectConfig,
  opts: UpOptions,
): Promise<void> {
  if (!opts.json) {
    console.log();
    line(
      `  Detected: ${chalk.cyan(FRAMEWORK_LABELS[projectCfg.framework as Framework] ?? projectCfg.framework)}`,
      opts,
    );
    line(
      `  Found .miosa.json → redeploying ${chalk.bold(projectCfg.name)}`,
      opts,
    );
    console.log();
  }

  lineProgress("Queuing build...", opts);
  try {
    await client.redeployDeployment(projectCfg.deploymentId);
  } catch (err) {
    handleError(err);
  }
  lineProgress("Build queued", opts);

  if (!opts.json) {
    console.log();
    line(`  ${chalk.bold("Build log:")}`, opts);
    line(`  ${"─".repeat(60)}`, opts);
  }

  const buildResult = await streamDeployLogs(
    client,
    projectCfg.deploymentId,
    opts,
  );

  if (!opts.json) {
    line(`  ${"─".repeat(60)}`, opts);
    console.log();
  }

  if (buildResult === "success") {
    try {
      const dep = await client.getDeployment(projectCfg.deploymentId);
      const tenant = await client.getTenant();
      const url = `https://${dep.slug}.${tenant.slug}.miosa.app`;

      if (opts.json) {
        console.log(
          JSON.stringify({ id: dep.id, url, name: dep.name, state: dep.state }),
        );
      } else {
        console.log(chalk.green("  Deployed"));
        console.log();
        console.log(`  ${chalk.bold("URL:")}    ${chalk.cyan(url)}`);
        console.log();
      }
    } catch {
      if (opts.json) {
        console.log(
          JSON.stringify({ id: projectCfg.deploymentId, state: "running" }),
        );
      } else {
        console.log(chalk.green("  Deployed"));
      }
    }
  } else {
    if (opts.json) {
      console.log(
        JSON.stringify({ id: projectCfg.deploymentId, state: "failed" }),
      );
    } else {
      console.log(chalk.red("  Build failed."));
      console.log();
      console.log(chalk.dim("  View full logs: miosa deploy logs"));
    }
    process.exit(1);
  }
}

// ── Mode: first deploy ────────────────────────────────────────────────────────

async function runFirstDeploy(
  cwd: string,
  client: MiosaClient,
  opts: UpOptions,
): Promise<void> {
  const { repoUrl, currentBranch } = getGitInfo(cwd);
  const detection = detectFramework(cwd);
  const hasDockerfile = fs.existsSync(path.join(cwd, "Dockerfile"));

  let framework = "unknown";
  let buildCommand = "npm run build";
  let runCommand = "npm start";
  let frameworkLabel = "application";

  if (detection) {
    framework = detection.framework;
    buildCommand = detection.buildCommand;
    runCommand = detection.runCommand;
    frameworkLabel =
      FRAMEWORK_LABELS[detection.framework as Framework] ?? detection.framework;
  } else if (hasDockerfile) {
    frameworkLabel = "container (Dockerfile)";
    buildCommand = "";
    runCommand = "";
  }

  if (!opts.json) {
    console.log();
    if (detection) {
      line(
        `  Detected: ${chalk.cyan(frameworkLabel)} (confidence ${detection.confidence}%)`,
        opts,
      );
    } else if (hasDockerfile) {
      line(`  Detected: ${chalk.cyan("Dockerfile")}`, opts);
    } else {
      line(
        chalk.yellow("  No framework detected — deploying as generic app"),
        opts,
      );
    }
    line(`  Repo:   ${chalk.dim(repoUrl)}`, opts);
    line(`  Branch: ${chalk.dim(currentBranch)}`, opts);
    console.log();
  }

  // ── Determine deploy parameters ──────────────────────────────────────────
  let deployName: string;
  let deployBranch: string;
  let deployBuild: string;
  let deployRun: string;

  const defaultName = path.basename(cwd).replace(/[^a-z0-9-]/gi, "-");

  if (opts.yes || opts.json) {
    // Non-interactive: use flags or defaults
    deployName = opts.name ?? defaultName;
    deployBranch = currentBranch;
    deployBuild = buildCommand;
    deployRun = runCommand;
  } else {
    // Interactive
    const { default: inquirer } = await import("inquirer");
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
        message: "Name:",
        default: opts.name ?? defaultName,
        validate: (v: string) => (v.length > 0 ? true : "Name is required"),
      },
      {
        type: "input",
        name: "branch",
        message: "Branch:",
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
        message: "Deploy?",
        default: true,
      },
    ]);

    if (!answers.confirm) {
      line(chalk.dim("  Cancelled."), opts);
      process.exit(0);
    }

    deployName = answers.name;
    deployBranch = answers.branch;
    deployBuild = answers.buildCommand;
    deployRun = answers.runCommand;
  }

  // ── Create deployment ─────────────────────────────────────────────────────
  lineProgress(`Creating deployment "${deployName}"...`, opts);

  let deployment: Deployment;
  let webhookSecret: string;

  try {
    const result = await client.createDeployment({
      name: deployName,
      repo_url: repoUrl,
      branch: deployBranch,
      build_command: deployBuild || undefined,
      run_command: deployRun || undefined,
      auto_deploy: true,
    });
    deployment = result.data;
    webhookSecret = result.webhook_secret;
  } catch (err) {
    handleError(err);
  }

  lineProgress(`Deployment "${deployment.name}" created`, opts);

  // ── Save .miosa.json ──────────────────────────────────────────────────────
  const projectCfg: MiosaProjectConfig = {
    version: 1,
    deploymentId: toDeploymentId(deployment.id),
    name: deployment.name,
    framework,
    buildCommand: deployBuild,
    runCommand: deployRun,
    branch: deployBranch,
  };
  saveProjectConfig(cwd, projectCfg);
  if (!opts.json) lineProgress("Saved .miosa.json", opts);

  // ── Webhook notice (human-only — agents don't need this) ──────────────────
  if (!opts.json && !opts.yes) {
    console.log();
    console.log(chalk.bold.yellow("  ACTION REQUIRED — GitHub Webhook"));
    console.log(
      chalk.dim("  The webhook secret below is shown ONCE. Store it now."),
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
    console.log(chalk.dim("  Add this at: " + repoUrl + "/settings/hooks/new"));
    console.log();
  }

  // ── Trigger initial build ─────────────────────────────────────────────────
  lineProgress("Queuing initial build...", opts);
  try {
    await client.redeployDeployment(projectCfg.deploymentId);
  } catch (err) {
    handleError(err);
  }
  lineProgress("Build queued", opts);

  // ── Stream logs ───────────────────────────────────────────────────────────
  if (!opts.json) {
    console.log();
    line(`  ${chalk.bold("Build log:")}`, opts);
    line(`  ${"─".repeat(60)}`, opts);
  }

  const buildResult = await streamDeployLogs(
    client,
    projectCfg.deploymentId,
    opts,
  );

  if (!opts.json) {
    line(`  ${"─".repeat(60)}`, opts);
    console.log();
  }

  if (buildResult === "success") {
    try {
      const dep = await client.getDeployment(projectCfg.deploymentId);
      const tenant = await client.getTenant();
      const url = `https://${dep.slug}.${tenant.slug}.miosa.app`;

      if (opts.json) {
        console.log(
          JSON.stringify({ id: dep.id, url, name: dep.name, state: dep.state }),
        );
      } else {
        console.log(chalk.green("  Deployed"));
        console.log();
        console.log(`  ${chalk.bold("URL:")}    ${chalk.cyan(url)}`);
        console.log();
        console.log(chalk.dim("  Next steps:"));
        console.log(
          chalk.dim("    miosa deploy logs              — tail logs"),
        );
        console.log(
          chalk.dim(
            "    miosa deploy domain add example.com   — add custom domain",
          ),
        );
        console.log(
          chalk.dim("    miosa deploy env set KEY=VALUE         — set env var"),
        );
      }
    } catch {
      if (opts.json) {
        console.log(JSON.stringify({ id: deployment.id, state: "running" }));
      } else {
        console.log(chalk.green("  Deployed"));
      }
    }
  } else {
    if (opts.json) {
      console.log(JSON.stringify({ id: deployment.id, state: "failed" }));
    } else {
      console.log(chalk.red("  Build failed."));
      console.log();
      console.log(chalk.dim("  View full logs: miosa deploy logs"));
    }
    process.exit(1);
  }
}

// ── Mode: computer ────────────────────────────────────────────────────────────

interface ComputerRecord {
  id: string;
  name: string;
  state: string;
  desktop_url?: string | null;
  tenant_slug?: string | null;
}

interface ComputerCreateResponse {
  data: ComputerRecord;
}

async function runComputerMode(
  client: MiosaClient,
  opts: UpOptions,
): Promise<void> {
  let computerName: string;
  let computerOs: string;
  let computerSize: string;

  if (opts.yes || opts.json) {
    computerName = opts.name ?? `my-computer-${Date.now().toString(36)}`;
    computerOs = opts.os;
    computerSize = opts.size;
  } else {
    const { default: inquirer } = await import("inquirer");
    const answers = await inquirer.prompt<{
      name: string;
      os: string;
      size: string;
    }>([
      {
        type: "input",
        name: "name",
        message: "Computer name:",
        default: opts.name ?? "my-computer",
      },
      {
        type: "list",
        name: "os",
        message: "Operating system:",
        choices: [
          { name: "Ubuntu 22.04", value: "ubuntu" },
          { name: "Debian 12", value: "debian" },
          { name: "macOS (coming soon)", value: "macos", disabled: true },
        ],
        default: opts.os,
      },
      {
        type: "list",
        name: "size",
        message: "Size:",
        choices: [
          { name: "small   (2 vCPU, 4 GB RAM)", value: "small" },
          { name: "medium  (4 vCPU, 8 GB RAM)", value: "medium" },
          { name: "large   (8 vCPU, 16 GB RAM)", value: "large" },
        ],
        default: opts.size,
      },
    ]);
    computerName = answers.name;
    computerOs = answers.os;
    computerSize = answers.size;
  }

  if (!opts.json) {
    console.log();
    lineProgress(`Creating computer "${computerName}"...`, opts);
  }

  let computer: ComputerRecord;
  try {
    const result = await client.apiPost<ComputerCreateResponse>(
      "/api/v1/computers",
      {
        name: computerName,
        os: computerOs,
        size: computerSize,
        desktop: true,
      },
    );
    computer = result.data;
  } catch (err) {
    handleError(err);
  }

  // Poll until running or timeout (30s)
  lineProgress("Booting...", opts);
  const deadline = Date.now() + 30_000;
  let finalComputer = computer;

  while (Date.now() < deadline) {
    try {
      const polled = await client.apiPost<ComputerCreateResponse>(
        `/api/v1/computers/${encodeURIComponent(computer.id)}/show`,
        {},
      );
      finalComputer = polled.data;
      if (finalComputer.state === "running") break;
    } catch {
      // poll errors are transient — keep trying
    }
    await sleep(1_000);
    lineProgress(`  state: ${finalComputer.state}`, opts);
  }

  const desktopUrl =
    finalComputer.desktop_url ??
    `https://app.miosa.ai/computers/${finalComputer.id}`;

  if (opts.json) {
    console.log(
      JSON.stringify({
        id: finalComputer.id,
        name: finalComputer.name,
        state: finalComputer.state,
        url: desktopUrl,
      }),
    );
  } else {
    console.log();
    console.log(chalk.green("  Ready"));
    console.log();
    console.log(`  ${chalk.bold("Desktop:")}   ${chalk.cyan(desktopUrl)}`);
    console.log(
      `  ${chalk.bold("SSH:")}       ${chalk.dim(`miosa ssh ${finalComputer.id}`)}`,
    );
    console.log();
  }
}

// ── Mode: sandbox ─────────────────────────────────────────────────────────────

interface SandboxRecord {
  id: string;
  name: string;
  state: string;
}

interface SandboxCreateResponse {
  data: SandboxRecord;
}

async function runSandboxMode(
  client: MiosaClient,
  opts: UpOptions,
): Promise<void> {
  let sandboxName: string;
  let sandboxImage: string;

  if (opts.yes || opts.json) {
    sandboxName = opts.name ?? `sandbox-${Date.now().toString(36)}`;
    sandboxImage = opts.image;
  } else {
    const { default: inquirer } = await import("inquirer");
    const answers = await inquirer.prompt<{
      name: string;
      image: string;
    }>([
      {
        type: "input",
        name: "name",
        message: "Sandbox name:",
        default: opts.name ?? "my-sandbox",
      },
      {
        type: "list",
        name: "image",
        message: "Image:",
        choices: [
          { name: "miosa-sandbox (default)", value: "miosa-sandbox" },
          { name: "python-3.12", value: "python-3.12" },
          { name: "node-20", value: "node-20" },
          { name: "ubuntu-22.04", value: "ubuntu-22.04" },
        ],
        default: opts.image,
      },
    ]);
    sandboxName = answers.name;
    sandboxImage = answers.image;
  }

  if (!opts.json) {
    console.log();
    lineProgress(`Creating sandbox "${sandboxName}"...`, opts);
  }

  const start = Date.now();
  let sandbox: SandboxRecord;

  try {
    const result = await client.apiPost<SandboxCreateResponse>(
      "/api/v1/sandboxes",
      {
        name: sandboxName,
        template_id: sandboxImage,
      },
    );
    sandbox = result.data;
  } catch (err) {
    handleError(err);
  }

  const elapsed = Date.now() - start;

  if (opts.json) {
    console.log(
      JSON.stringify({
        id: sandbox.id,
        name: sandbox.name,
        state: sandbox.state,
      }),
    );
  } else {
    console.log(chalk.green(`  Ready (${elapsed}ms)`));
    console.log();
    console.log(
      `  ${chalk.bold("Exec:")}   ${chalk.dim(`miosa sandbox exec ${sandbox.id} "python app.py"`)}`,
    );
    console.log(
      `  ${chalk.bold("SSH:")}    ${chalk.dim(`miosa sandbox ssh ${sandbox.id}`)}`,
    );
    console.log();
  }
}

// ── Mode: interactive disambiguation ─────────────────────────────────────────

async function runInteractiveDisambiguate(
  cwd: string,
  client: MiosaClient,
  opts: UpOptions,
): Promise<void> {
  const { default: inquirer } = await import("inquirer");

  console.log();
  console.log(
    `  ${chalk.dim("No project detected in current directory. What would you like to create?")}`,
  );
  console.log();

  const { action } = await inquirer.prompt<{
    action: "deploy" | "computer" | "sandbox";
  }>([
    {
      type: "list",
      name: "action",
      message: "Action:",
      choices: [
        { name: "Deploy a GitHub repository", value: "deploy" },
        { name: "Create a desktop computer", value: "computer" },
        { name: "Create a sandbox", value: "sandbox" },
      ],
    },
  ]);

  switch (action) {
    case "deploy":
      await runFirstDeploy(cwd, client, opts);
      break;
    case "computer":
      await runComputerMode(client, opts);
      break;
    case "sandbox":
      await runSandboxMode(client, opts);
      break;
  }
}

// ── Context detection ─────────────────────────────────────────────────────────

function detectMode(cwd: string, opts: UpOptions): UpMode {
  // Explicit flags override everything
  if (opts.computer) return "computer";
  if (opts.sandbox) return "sandbox";

  // Existing project config
  if (loadProjectConfig(cwd)) return "redeploy";

  // Deployable source code present
  const hasPackageJson = fs.existsSync(path.join(cwd, "package.json"));
  const hasMixExs = fs.existsSync(path.join(cwd, "mix.exs"));
  const hasRequirements = fs.existsSync(path.join(cwd, "requirements.txt"));
  const hasDockerfile = fs.existsSync(path.join(cwd, "Dockerfile"));
  const hasGoMod = fs.existsSync(path.join(cwd, "go.mod"));
  const hasCargo = fs.existsSync(path.join(cwd, "Cargo.toml"));
  const hasGemfile = fs.existsSync(path.join(cwd, "Gemfile"));
  const hasIndexHtml = fs.existsSync(path.join(cwd, "index.html"));

  if (
    hasPackageJson ||
    hasMixExs ||
    hasRequirements ||
    hasDockerfile ||
    hasGoMod ||
    hasCargo ||
    hasGemfile ||
    hasIndexHtml
  ) {
    return "deploy-new";
  }

  return "interactive";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("up")
    .description(
      "Smart launch: deploy app, create computer, or start sandbox — auto-detected from context",
    )
    .addHelpText(
      "after",
      `
Context detection (evaluated in order):
  .miosa.json / miosa.json found  → redeploy existing deployment
  --computer flag                  → create a desktop computer
  --sandbox flag                   → create a sandbox
  package.json / mix.exs / etc.    → detect framework, deploy
  empty directory                  → interactive mode

Examples:
  miosa up                                        Auto-detect and deploy
  miosa up --yes --json --name my-app             Scriptable deploy (no prompts)
  miosa up --computer --os ubuntu --size medium   Create a desktop computer
  miosa up --sandbox --image python-3.12          Create a Python sandbox
  miosa up --computer --yes --json                Scriptable computer creation
`,
    )
    .option("-y, --yes", "Skip all interactive prompts, use defaults", false)
    .option("--json", "Output machine-readable JSON (implies --yes)", false)
    .option("--name <name>", "Resource name (app, computer, or sandbox)")
    // computer options
    .option("--computer", "Create a desktop computer", false)
    .option("--os <os>", "Operating system for computer mode", "ubuntu")
    .option("--size <size>", "Size: small | medium | large", "small")
    // sandbox options
    .option("--sandbox", "Create a sandbox", false)
    .option("--image <image>", "Sandbox image/template", "miosa-sandbox")
    .action(async (rawOpts: UpOptions) => {
      // --json implies --yes
      const opts: UpOptions = { ...rawOpts, yes: rawOpts.yes || rawOpts.json };

      try {
        const cwd = process.cwd();
        const config = loadConfig();
        const client = new MiosaClient(config);
        const mode = detectMode(cwd, opts);

        switch (mode) {
          case "redeploy": {
            const projectCfg = loadProjectConfig(cwd);
            // projectCfg is guaranteed non-null when mode === "redeploy"
            await runRedeploy(client, projectCfg!, opts);
            break;
          }
          case "deploy-new":
            await runFirstDeploy(cwd, client, opts);
            break;
          case "computer":
            await runComputerMode(client, opts);
            break;
          case "sandbox":
            await runSandboxMode(client, opts);
            break;
          case "interactive":
            if (opts.yes || opts.json) {
              // Non-interactive but no context — require explicit flag
              throw new UserError(
                "Cannot determine what to create. Specify --computer, --sandbox, or run from a project directory.",
                "Examples:\n  miosa up --computer\n  miosa up --sandbox\n  cd my-project && miosa up",
              );
            }
            await runInteractiveDisambiguate(cwd, client, opts);
            break;
        }
      } catch (err) {
        handleError(err);
      }
    });
}
