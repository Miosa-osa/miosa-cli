import type { Command } from "commander";
import chalk from "chalk";
import {
  inspectApp,
  planApp,
  type AppGoal,
} from "../app-advisor.js";
import { handleError, isJsonMode, printJson } from "./util.js";

interface AppCommandOptions {
  json?: boolean;
}

interface AppPlanOptions extends AppCommandOptions {
  goal?: AppGoal;
  slug?: string;
  workspace?: string;
  dockerDeploy?: boolean;
  noDockerDeploy?: boolean;
}

function validGoal(value: string): AppGoal {
  if (value === "preview" || value === "deploy" || value === "docker-deploy") {
    return value;
  }
  throw new Error("Invalid goal. Expected preview, deploy, or docker-deploy.");
}

function printInspectHuman(result: ReturnType<typeof inspectApp>): void {
  console.log();
  console.log(chalk.bold("MIOSA app inspection"));
  console.log();
  console.log(`  Path:        ${result.path}`);
  console.log(
    `  Framework:   ${result.framework.label} (${result.framework.confidence}%)`,
  );
  console.log(`  Template:    ${result.recommendation.template}`);
  console.log(`  Deployment:  ${result.recommendation.deployment}`);
  console.log(`  Port:        ${result.runtime.port ?? "unknown"}`);
  console.log(`  Probe path:  ${result.runtime.probe_path}`);
  console.log(`  Build:       ${result.commands.build ?? "unknown"}`);
  console.log(`  Start:       ${result.commands.start ?? "unknown"}`);
  console.log(`  Env keys:    ${result.runtime.env_keys.join(", ") || "none"}`);
  if (result.manifest) console.log(`  Manifest:    ${result.manifest.path}`);
  if (result.dockerfile) console.log(`  Dockerfile:  ${result.dockerfile}`);
  console.log();
  console.log(chalk.bold("Recommendation"));
  console.log(`  ${result.recommendation.reason}`);
  if (result.risks.length > 0) {
    console.log();
    console.log(chalk.bold("Risks"));
    for (const risk of result.risks) console.log(`  - ${risk}`);
  }
  console.log();
  console.log(chalk.dim("Machine-readable form: miosa app inspect . --json"));
  console.log(chalk.dim("Next: miosa app plan . --goal deploy --json"));
  console.log();
}

function printPlanHuman(result: ReturnType<typeof planApp>): void {
  console.log();
  console.log(chalk.bold("MIOSA app plan"));
  console.log();
  console.log(`  Goal:        ${result.goal}`);
  console.log(`  Deploy:      ${result.recommended_deploy}`);
  console.log(`  Template:    ${result.template}`);
  console.log(`  Port:        ${result.port ?? "unknown"}`);
  console.log(`  Probe path:  ${result.probe_path}`);
  console.log();
  for (const [index, step] of result.steps.entries()) {
    console.log(`${index + 1}. ${chalk.cyan(step.id)}`);
    console.log(`   ${step.purpose}`);
    console.log(`   ${chalk.dim(step.command)}`);
  }
  console.log();
  console.log(chalk.dim("Machine-readable form: miosa app plan . --json"));
  console.log();
}

export function register(program: Command): void {
  const app = program
    .command("app")
    .description("Inspect local apps and generate agent-safe MIOSA plans");

  app
    .command("inspect")
    .argument("[path]", "Local app directory", ".")
    .description(
      "Detect framework, commands, ports, env needs, and recommended MIOSA deployment path",
    )
    .option("--json", "Output compact machine-readable JSON")
    .action((dir: string, opts: AppCommandOptions) => {
      try {
        const result = inspectApp(dir);
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result, error: null });
          return;
        }
        printInspectHuman(result);
      } catch (err) {
        handleError(err);
      }
    });

  app
    .command("plan")
    .argument("[path]", "Local app directory", ".")
    .description("Generate the exact MIOSA command sequence for an app")
    .option(
      "--goal <goal>",
      "Plan goal: preview, deploy, or docker-deploy",
      validGoal,
      "deploy",
    )
    .option("--slug <slug>", "Production app slug placeholder/value")
    .option("--workspace <id>", "Workspace ID for scoped create commands")
    .option("--docker-deploy", "Force Docker Deploy production path")
    .option("--no-docker-deploy", "Prefer standard MIOSA Deploy path")
    .option("--json", "Output compact machine-readable JSON")
    .action((dir: string, opts: AppPlanOptions) => {
      try {
        const result = planApp(dir, {
          goal: opts.goal,
          slug: opts.slug,
          workspace: opts.workspace,
          preferDockerDeploy:
            opts.dockerDeploy || opts.goal === "docker-deploy"
              ? true
              : opts.noDockerDeploy
                ? false
                : undefined,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result, error: null });
          return;
        }
        printPlanHuman(result);
      } catch (err) {
        handleError(err);
      }
    });
}
