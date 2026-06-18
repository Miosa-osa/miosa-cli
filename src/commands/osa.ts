import type { Command } from "commander";
import chalk from "chalk";
import { handleError, isJsonMode, printJson } from "./util.js";
import { initOsaProject } from "../osa/scaffold.js";
import { discoverOsaProject } from "../osa/discovery.js";
import { addSkill, listSkills, searchSkills } from "../osa/skills.js";
import { enableComputer } from "../osa/computer.js";
import { runOsaDoctor } from "../osa/doctor.js";
import { buildOsaProject } from "../osa/build.js";
import { runOsaEvals } from "../osa/eval.js";
import { createOsaPlan } from "../osa/plans.js";
import { addChannel, addConnection } from "../osa/integrations.js";
import { dispatchOsaRun } from "../osa/runtime.js";
import {
  cancelOsaDeployment,
  deployOsaProject,
  getOsaDeployment,
  listOsaDeployments,
  retryOsaDeployment,
} from "../osa/deployments.js";
import { getOsaProject, listOsaProjects, publishOsaProject } from "../osa/projects.js";
import { UserError } from "../errors.js";
import type { OsaDiagnostic, OsaSkill } from "../osa/types.js";

interface JsonOption {
  json?: boolean;
}

interface TargetOption extends JsonOption {
  target?: string;
}

interface ForceTargetOption extends TargetOption {
  force?: boolean;
}

interface ProjectOption extends JsonOption {
  project?: string;
  dryRun?: boolean;
  runtimeTarget?: string;
  deployTarget?: string;
  osaProjectId?: string;
  workspace?: string;
  projectId?: string;
  sandbox?: string;
  computer?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  timeout?: string;
  wait?: boolean;
  waitTimeout?: string;
}

interface PublishOption extends JsonOption {
  target?: string;
  workspace?: string;
  projectId?: string;
  name?: string;
  slug?: string;
  source?: string;
  dryRun?: boolean;
}

interface ProjectsOption extends JsonOption {
  workspace?: string;
  projectId?: string;
  status?: string;
  limit?: string;
}

interface DeploymentsOption extends JsonOption {
  status?: string;
  limit?: string;
}

export function register(program: Command): void {
  const osa = program
    .command("osa")
    .description("Manage filesystem-defined OSA Projects");

  osa
    .command("init [target]")
    .description("Scaffold an OSA Project")
    .option("-f, --force", "Overwrite existing scaffolded OSA files")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: ForceTargetOption) => {
      try {
        const result = initOsaProject({ target, force: opts.force });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        console.log(chalk.green(`Created OSA project at ${result.projectRoot}`));
        if (result.created.length > 0) {
          console.log(chalk.dim(`  ${result.created.length} file(s) written`));
        }
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("info [target]")
    .description("Inspect an OSA Project and write discovery artifacts")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: TargetOption) => {
      try {
        const discovery = discoverOsaProject({ target });
        if (isJsonMode(opts)) {
          printJson({ ok: discovery.manifest.diagnostics.errors === 0, data: discovery });
          if (discovery.manifest.diagnostics.errors > 0) process.exitCode = 1;
          return;
        }
        renderInfo(discovery.manifest, discovery.diagnostics);
        if (discovery.manifest.diagnostics.errors > 0) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("doctor [target]")
    .description("Diagnose OSA Project shape and local readiness")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: TargetOption) => {
      try {
        const result = runOsaDoctor({ target });
        const ok = result.checks.every((check) => check.ok || check.warn);
        if (isJsonMode(opts)) {
          printJson({ ok, data: result });
          if (!ok) process.exitCode = 1;
          return;
        }
        renderDoctor(result.checks);
        if (!ok) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("build [target]")
    .description("Build OSA discovery artifacts for runtime consumption")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: TargetOption) => {
      try {
        const artifact = buildOsaProject({ target });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: artifact });
          return;
        }
        console.log(chalk.green("Built OSA project"));
        console.log(chalk.dim(`  ${artifact.manifestPath}`));
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("publish [target]")
    .description("Publish an OSA Project manifest to MIOSA")
    .option("--workspace <id>", "Workspace ID for the OSA Project")
    .option("--project-id <id>", "Canonical MIOSA project ID to link")
    .option("--name <name>", "Override published OSA project name")
    .option("--slug <slug>", "Override published OSA project slug")
    .option("--source <source>", "Publish source label", "miosa-cli")
    .option("--dry-run", "Build and print the publish request without contacting the backend")
    .option("--json", "Output JSON")
    .action(async (target: string | undefined, opts: PublishOption) => {
      try {
        const result = await publishOsaProject({
          target,
          workspace: opts.workspace,
          projectId: opts.projectId,
          name: opts.name,
          slug: opts.slug,
          source: opts.source,
          dryRun: opts.dryRun,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        if (result.project) {
          console.log(chalk.green(`Published OSA project ${String(result.project["id"] ?? "")}`));
          console.log(chalk.dim(`  ${String(result.project["name"] ?? result.request.name ?? "")}`));
        } else {
          console.log(chalk.bold("OSA publish request"));
          console.log(chalk.dim(`Manifest: ${result.build.manifestPath}`));
          console.log(JSON.stringify(result.request, null, 2));
        }
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("eval [target]")
    .description("Run OSA project eval descriptor checks")
    .option("--strict", "Fail when no evals are present")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: TargetOption & { strict?: boolean }) => {
      try {
        const report = runOsaEvals({ target, strict: opts.strict });
        if (isJsonMode(opts)) {
          printJson({ ok: report.ok, data: report });
          if (!report.ok) process.exitCode = 1;
          return;
        }
        for (const result of report.results) {
          const marker = result.status === "passed" ? chalk.green("pass") : chalk.red("fail");
          console.log(`${marker} ${result.name}`);
          for (const check of result.checks) {
            console.log(chalk.dim(`  ${check.status}: ${check.name} - ${check.detail}`));
          }
        }
        if (!report.ok) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("run <task...>")
    .description("Dispatch an OSA task to a Sandbox or Computer")
    .option("--project <path>", "OSA project root")
    .option("--sandbox <id>", "Sandbox runtime target ID")
    .option("--computer <id>", "Computer runtime target ID")
    .option("--provider <provider>", "Override configured harness/provider")
    .option("--model <model>", "Model identifier")
    .option("--cwd <path>", "Runtime working directory")
    .option("--timeout <seconds>", "Runtime timeout in seconds")
    .option("--dry-run", "Print and write the dispatch plan without contacting the backend")
    .option("--json", "Output JSON")
    .action(async (taskParts: string[], opts: ProjectOption) => {
      try {
        const result = await dispatchOsaRun({
          project: opts.project,
          task: taskParts.join(" "),
          sandbox: opts.sandbox,
          computer: opts.computer,
          provider: opts.provider,
          model: opts.model,
          cwd: opts.cwd,
          timeout: opts.timeout,
          dryRun: opts.dryRun,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        if (result.run) {
          console.log(chalk.green("Dispatched OSA run"));
          console.log(JSON.stringify(result.run, null, 2));
        } else {
          renderPlan(result.plan);
        }
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("dev [target]")
    .description("Prepare an OSA local development runtime plan")
    .option("--runtime-target <target>", "Runtime target: local, miosa-cloud, opencomputer, byoc")
    .option("--dry-run", "Print and write the dev plan without starting a runtime")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: ProjectOption) => {
      try {
        const plan = createOsaPlan({
          kind: "dev",
          target,
          runtimeTarget: opts.runtimeTarget ?? "local",
        });
        if (!opts.dryRun) {
          throw new UserError(
            "OSA dev runtime is not wired in this CLI release.",
            "Re-run with --dry-run to inspect the exact local runtime plan.",
          );
        }
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: plan });
          return;
        }
        renderPlan(plan);
      } catch (err) {
        handleError(err);
      }
    });

  osa
    .command("deploy [target]")
    .description("Deploy an OSA Project through MIOSA")
    .option("--deploy-target <target>", "Deployment target: miosa-cloud, opencomputer, byoc")
    .option("--workspace <id>", "Workspace ID for first publish")
    .option("--project-id <id>", "Canonical MIOSA project ID to link on first publish")
    .option("--osa-project-id <id>", "Existing published OSA Project ID")
    .option("--sandbox <id>", "Deploy/bootstrap against an explicit Sandbox target")
    .option("--computer <id>", "Deploy/bootstrap against an explicit Computer target")
    .option("--wait", "Wait for the deployment to reach deployed, failed, or canceled")
    .option("--wait-timeout <seconds>", "Maximum seconds to wait for deployment", "600")
    .option("--dry-run", "Print and write the deploy plan without deploying")
    .option("--json", "Output JSON")
    .action(async (target: string | undefined, opts: ProjectOption) => {
      try {
        const plan = createOsaPlan({
          kind: "deploy",
          target,
          runtimeTarget: opts.sandbox ? "sandbox" : opts.computer ? "computer" : opts.deployTarget,
        });
        if (!opts.dryRun) {
          const result = await deployOsaProject({
            target,
            workspace: opts.workspace,
            projectId: opts.projectId,
            osaProjectId: opts.osaProjectId,
            deployTarget: opts.deployTarget,
            sandbox: opts.sandbox,
            computer: opts.computer,
            wait: opts.wait,
            waitTimeout: opts.waitTimeout,
          });
          const status = String(result.deployment["status"] ?? "");
          const ok = !opts.wait || status === "deployed";
          if (isJsonMode(opts)) {
            printJson({ ok, data: result });
            if (!ok) process.exitCode = 1;
            return;
          }
          console.log(chalk.green(`Created OSA deployment ${String(result.deployment["id"] ?? "")}`));
          console.log(chalk.dim(`  OSA project: ${result.osaProjectId}`));
          console.log(chalk.dim(`  Status: ${status}`));
          if (result.deployment["runtime_url"]) {
            console.log(chalk.dim(`  Runtime URL: ${String(result.deployment["runtime_url"])}`));
          }
          if (!ok) process.exitCode = 1;
          return;
        }
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: plan });
          return;
        }
        renderPlan(plan);
      } catch (err) {
        handleError(err);
      }
    });

  const projects = osa.command("projects").description("Inspect published OSA Projects");

  projects
    .command("list")
    .description("List published OSA Projects")
    .option("--workspace <id>", "Workspace ID filter")
    .option("--project-id <id>", "Canonical MIOSA project ID filter")
    .option("--status <status>", "Status filter")
    .option("--limit <n>", "Maximum rows")
    .option("--json", "Output JSON")
    .action(async (opts: ProjectsOption) => {
      try {
        const rows = await listOsaProjects({
          workspace: opts.workspace,
          projectId: opts.projectId,
          status: opts.status,
          limit: opts.limit,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: rows });
          return;
        }
        renderPublishedProjects(rows);
      } catch (err) {
        handleError(err);
      }
    });

  projects
    .command("show <id>")
    .description("Show a published OSA Project")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: JsonOption) => {
      try {
        const project = await getOsaProject(id);
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: project });
          return;
        }
        renderPublishedProjects([project]);
      } catch (err) {
        handleError(err);
      }
    });

  const deployments = osa.command("deployments").description("Inspect OSA Project deployments");

  deployments
    .command("list <osaProjectId>")
    .description("List deployments for a published OSA Project")
    .option("--status <status>", "Status filter")
    .option("--limit <n>", "Maximum rows")
    .option("--json", "Output JSON")
    .action(async (osaProjectId: string, opts: DeploymentsOption) => {
      try {
        const rows = await listOsaDeployments(osaProjectId, {
          status: opts.status,
          limit: opts.limit,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: rows });
          return;
        }
        renderDeployments(rows);
      } catch (err) {
        handleError(err);
      }
    });

  deployments
    .command("show <osaProjectId> <deploymentId>")
    .description("Show an OSA Project deployment")
    .option("--json", "Output JSON")
    .action(async (osaProjectId: string, deploymentId: string, opts: JsonOption) => {
      try {
        const deployment = await getOsaDeployment(osaProjectId, deploymentId);
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: deployment });
          return;
        }
        renderDeployments([deployment]);
      } catch (err) {
        handleError(err);
      }
    });

  deployments
    .command("retry <osaProjectId> <deploymentId>")
    .description("Retry a failed or canceled OSA Project deployment")
    .option("--json", "Output JSON")
    .action(async (osaProjectId: string, deploymentId: string, opts: JsonOption) => {
      try {
        const deployment = await retryOsaDeployment(osaProjectId, deploymentId);
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: deployment });
          return;
        }
        console.log(chalk.green(`Retried OSA deployment ${String(deployment["id"] ?? "")}`));
        console.log(chalk.dim(`  Status: ${String(deployment["status"] ?? "")}`));
      } catch (err) {
        handleError(err);
      }
    });

  deployments
    .command("cancel <osaProjectId> <deploymentId>")
    .description("Cancel a queued or preparing OSA Project deployment")
    .option("--json", "Output JSON")
    .action(async (osaProjectId: string, deploymentId: string, opts: JsonOption) => {
      try {
        const deployment = await cancelOsaDeployment(osaProjectId, deploymentId);
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: deployment });
          return;
        }
        console.log(chalk.green(`Canceled OSA deployment ${String(deployment["id"] ?? "")}`));
        console.log(chalk.dim(`  Status: ${String(deployment["status"] ?? "")}`));
      } catch (err) {
        handleError(err);
      }
    });

  const skills = osa.command("skills").description("Manage OSA Project skills");

  skills
    .command("list [target]")
    .description("List project and built-in OSA skills")
    .option("--json", "Output JSON")
    .action((target: string | undefined, opts: TargetOption) => {
      try {
        const rows = listSkills({ target });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: rows });
          return;
        }
        renderSkills(rows);
      } catch (err) {
        handleError(err);
      }
    });

  skills
    .command("search <query>")
    .description("Search project and built-in OSA skills")
    .option("--target <path>", "OSA project root")
    .option("--json", "Output JSON")
    .action((query: string, opts: TargetOption) => {
      try {
        const rows = searchSkills(query, { target: opts.target });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: rows });
          return;
        }
        renderSkills(rows);
      } catch (err) {
        handleError(err);
      }
    });

  skills
    .command("add <nameOrSource>")
    .description("Install an OSA skill into agent/skills")
    .option("--target <path>", "OSA project root")
    .option("-f, --force", "Overwrite an existing skill")
    .option("--json", "Output JSON")
    .action((nameOrSource: string, opts: ForceTargetOption) => {
      try {
        const result = addSkill({
          nameOrSource,
          target: opts.target,
          force: opts.force,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result.installed });
          return;
        }
        console.log(chalk.green(`Installed OSA skill ${result.installed.name}`));
        console.log(chalk.dim(`  ${result.installed.path}`));
      } catch (err) {
        handleError(err);
      }
    });

  const computer = osa.command("computer").description("Manage OSA Computer profiles");

  computer
    .command("enable [name]")
    .description("Enable a Computer profile for this OSA Project")
    .option("--target <path>", "OSA project root")
    .option("--json", "Output JSON")
    .action((name: string | undefined, opts: TargetOption) => {
      try {
        const result = enableComputer({ name, target: opts.target });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        console.log(
          chalk.green(
            `${result.updated ? "Updated" : "Created"} OSA Computer profile ${result.name}`,
          ),
        );
      } catch (err) {
        handleError(err);
      }
    });

  const connections = osa.command("connections").description("Manage OSA connection descriptors");

  connections
    .command("add <kind> [name]")
    .description("Scaffold an OSA TypeScript connection")
    .option("--target <path>", "OSA project root")
    .option("--url <url>", "MCP server URL")
    .option("--spec <pathOrUrl>", "OpenAPI spec path or URL")
    .option("--description <text>", "Connection description")
    .option("--auth <mode>", "Auth mode: none, env, oauth")
    .option("-f, --force", "Overwrite an existing connection")
    .option("--json", "Output JSON")
    .action((kind: string, name: string | undefined, opts: ForceTargetOption & {
      url?: string;
      spec?: string;
      description?: string;
      auth?: "none" | "env" | "oauth";
    }) => {
      try {
        if (kind !== "mcp" && kind !== "openapi" && kind !== "linear" && kind !== "github" && kind !== "http") {
          throw new UserError("Invalid connection kind.", "Use mcp, openapi, linear, github, or http.");
        }
        const result = addConnection({
          kind,
          name,
          target: opts.target,
          url: opts.url,
          spec: opts.spec,
          description: opts.description,
          auth: opts.auth,
          force: opts.force,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        console.log(chalk.green(`Added OSA connection ${result.name}`));
      } catch (err) {
        handleError(err);
      }
    });

  const channels = osa.command("channels").description("Manage OSA channel descriptors");

  channels
    .command("add <kind> [name]")
    .description("Scaffold an OSA channel descriptor")
    .option("--target <path>", "OSA project root")
    .option("--description <text>", "Channel description")
    .option("-f, --force", "Overwrite an existing channel")
    .option("--json", "Output JSON")
    .action((kind: string, name: string | undefined, opts: ForceTargetOption & {
      description?: string;
    }) => {
      try {
        if (kind !== "web" && kind !== "slack" && kind !== "github" && kind !== "api") {
          throw new UserError("Invalid channel kind.", "Use web, slack, github, or api.");
        }
        const result = addChannel({
          kind,
          name,
          target: opts.target,
          description: opts.description,
          force: opts.force,
        });
        if (isJsonMode(opts)) {
          printJson({ ok: true, data: result });
          return;
        }
        console.log(chalk.green(`Added OSA channel ${result.name}`));
      } catch (err) {
        handleError(err);
      }
    });
}

function renderInfo(
  manifest: ReturnType<typeof discoverOsaProject>["manifest"],
  diagnostics: OsaDiagnostic[],
): void {
  console.log(chalk.bold(manifest.agent.name));
  if (manifest.agent.description) console.log(chalk.dim(manifest.agent.description));
  console.log();
  console.log(`OSA root: ${manifest.osaRoot}`);
  console.log(`Source root: ${manifest.sourceRoot}`);
  console.log(`Model: ${profileModel(manifest.runtimeProfile) ?? manifest.agent.model ?? "default"}`);
  console.log(`Harness: ${profileField(manifest.runtimeProfile.harness, "engine") ?? manifest.runtimeProfile.provider ?? "auto"}`);
  console.log(`Runtime: ${profileField(manifest.runtimeProfile.runtime, "target") ?? "local"}`);
  console.log(`Sandbox: ${profileField(manifest.runtimeProfile.sandbox, "backend") ?? "auto"}`);
  console.log(`Skills: ${manifest.skills.length}`);
  console.log(`Connections: ${manifest.connections.length}`);
  console.log(`Channels: ${manifest.channels.length}`);
  console.log(`Schedules: ${manifest.schedules.length}`);
  console.log(`Computers: ${manifest.computers.length}`);
  console.log(`Subagents: ${manifest.subagents.length}`);
  console.log(`Hooks: ${manifest.hooks.length}`);
  console.log(`Evals: ${manifest.evals.length}`);
  console.log(`Diagnostics: ${manifest.diagnostics.errors} error(s), ${manifest.diagnostics.warnings} warning(s)`);
  if (diagnostics.length > 0) {
    console.log();
    for (const item of diagnostics) {
      const color = item.severity === "error" ? chalk.red : chalk.yellow;
      console.log(color(`${item.severity.toUpperCase()} ${item.code}`));
      console.log(`  ${item.message}`);
      if (item.path) console.log(chalk.dim(`  ${item.path}`));
    }
  }
}

function renderDoctor(checks: Array<{ name: string; ok: boolean; detail: string; warn?: boolean; fix?: string }>): void {
  for (const check of checks) {
    const marker = check.ok ? chalk.green("ok") : check.warn ? chalk.yellow("warn") : chalk.red("fail");
    console.log(`${marker} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) console.log(chalk.dim(`  fix: ${check.fix}`));
  }
}

function renderSkills(skills: OsaSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.dim("No OSA skills found."));
    return;
  }
  for (const skill of skills) {
    console.log(`${chalk.bold(skill.name)} ${chalk.dim(`[${skill.source}/${skill.trust}]`)}`);
    console.log(`  ${skill.description}`);
  }
}

function renderPublishedProjects(projects: Record<string, unknown>[]): void {
  if (projects.length === 0) {
    console.log(chalk.dim("No OSA projects found."));
    return;
  }
  for (const project of projects) {
    console.log(`${chalk.bold(String(project["name"] ?? project["id"] ?? "osa-project"))}`);
    console.log(chalk.dim(`  id: ${String(project["id"] ?? "")}`));
    console.log(chalk.dim(`  workspace: ${String(project["workspace_id"] ?? "")}`));
    console.log(chalk.dim(`  status: ${String(project["status"] ?? "")}`));
  }
}

function renderDeployments(deployments: Record<string, unknown>[]): void {
  if (deployments.length === 0) {
    console.log(chalk.dim("No OSA deployments found."));
    return;
  }
  for (const deployment of deployments) {
    console.log(chalk.bold(String(deployment["id"] ?? "")));
    console.log(chalk.dim(`  OSA project: ${String(deployment["osa_project_id"] ?? "")}`));
    console.log(chalk.dim(`  status: ${String(deployment["status"] ?? "")}`));
    console.log(chalk.dim(`  target: ${String(deployment["target_kind"] ?? "")}`));
    if (deployment["runtime_url"]) {
      console.log(chalk.dim(`  runtime URL: ${String(deployment["runtime_url"])}`));
    }
  }
}

function renderPlan(plan: ReturnType<typeof createOsaPlan>): void {
  console.log(chalk.bold(`${plan.kind} plan for ${plan.agentName}`));
  console.log(`Target: ${plan.target}`);
  console.log(`Harness: ${profileField(plan.runtimeProfile.harness, "engine") ?? plan.runtimeProfile.provider ?? "auto"}`);
  console.log(`Model: ${profileModel(plan.runtimeProfile) ?? "default"}`);
  if (plan.task) console.log(`Task: ${plan.task}`);
  console.log(chalk.dim(`Manifest: ${plan.manifestPath}`));
  for (const step of plan.steps) {
    console.log(`- ${step.id}: ${step.description}`);
  }
}

function profileField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function profileModel(profile: ReturnType<typeof createOsaPlan>["runtimeProfile"]): string | undefined {
  if (typeof profile.model === "string") return profile.model;
  return (
    profileField(profile.model, "primary") ??
    profileField(profile.model, "id") ??
    profileField(profile.model, "default")
  );
}
