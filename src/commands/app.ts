import type { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { request } from "undici";
import {
  inspectApp,
  planApp,
  type AppGoal,
} from "../app-advisor.js";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { deploySandbox } from "./sandbox.js";
import { ensureGitignored, fetchSecretValues, toDotenv } from "./pull.js";
import { loadLocalLink } from "./link.js";
import {
  loadAcceptanceContract,
  saveReleaseReceipt,
  verifyApplicationRelease,
  type ReleaseInspection,
  type ReleaseReceipt,
} from "../app-release.js";
import {
  applicationIdempotencyKey,
  createApplicationOperation,
  loadApplicationOperation,
  updateApplicationOperation,
} from "../app-operation.js";
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

interface ApplicationLink {
  version: 2;
  deploymentId: string;
  name: string;
  environment: string;
  workspaceId?: string;
  projectId?: string;
}

function requireApplicationLink(dir: string): ApplicationLink {
  const link = loadLocalLink(dir);
  if (!link?.deploymentId || !link.name) {
    throw new UserError(
      "This directory is not linked to a MIOSA application.",
      "Run `miosa app link --app <deployment-id>` first.",
    );
  }
  return {
    version: 2,
    deploymentId: link.deploymentId,
    name: link.name,
    environment: link.environment,
    workspaceId: link.workspaceId,
    projectId: link.projectId,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, key: string): string | undefined {
  const found = record(value)[key];
  return typeof found === "string" && found.trim() ? found.trim() : undefined;
}

function deploymentPayload(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const data = record(outer["data"]);
  return Object.keys(data).length > 0 ? data : outer;
}

function boolValue(value: unknown, key: string): boolean | undefined {
  const found = record(value)[key];
  return typeof found === "boolean" ? found : undefined;
}

async function getRelease(
  client: MiosaClient,
  deploymentId: string,
  releaseId: string,
): Promise<Record<string, unknown>> {
  const raw = await client.apiGet<unknown>(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}/releases/${encodeURIComponent(releaseId)}`,
  );
  return deploymentPayload(raw);
}

function releaseVersionId(release: Record<string, unknown>): string | undefined {
  return (
    stringValue(release, "deployment_version_id") ??
    stringValue(release, "version_id") ??
    stringValue(release, "id")
  );
}

async function inspectLinkedRelease(
  client: MiosaClient,
  deploymentId: string,
  releaseId: string,
): Promise<{ inspection: ReleaseInspection; versionId: string }> {
  const [rawDeployment, release, env, connectors] = await Promise.all([
    client.apiGet<unknown>(
      `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
    ),
    getRelease(client, deploymentId, releaseId),
    client.apiGet<{ data?: Array<{ name?: string }> }>(
      `/api/v1/deployments/${encodeURIComponent(deploymentId)}/env`,
    ),
    client
      .apiGet<{ data?: Array<Record<string, unknown>> }>(
        `/api/v1/deployments/${encodeURIComponent(deploymentId)}/connectors`,
      )
      .catch(() => ({ data: [] })),
  ]);
  const deployment = deploymentPayload(rawDeployment);
  const dockerApp = record(deployment["docker_deploy_app"]);
  const metadata = record(deployment["metadata"]);
  const releaseMetadata = record(release["metadata"]);
  const versionId = releaseVersionId(release);
  if (!versionId) {
    throw new UserError(
      `Release ${releaseId} has no immutable version ID.`,
      "The publish operation did not create a promotable immutable version.",
    );
  }
  const envNames = (env.data ?? [])
    .map((item) => item.name)
    .filter((name): name is string => typeof name === "string");
  const hostId =
    stringValue(deployment, "docker_deploy_host_id") ??
    stringValue(dockerApp, "docker_deploy_host_id");
  const product =
    stringValue(deployment, "deployment_product") ?? "miosa_deploy";
  const activeVersion =
    stringValue(deployment, "active_version_id") ??
    stringValue(dockerApp, "deployment_version_id");
  const activeRelease =
    stringValue(deployment, "active_release_id") ??
    stringValue(metadata, "active_release_id") ??
    (activeVersion === versionId ? releaseId : undefined);
  const expectedDigest =
    stringValue(release, "artifact_sha256") ??
    stringValue(release, "archive_sha256") ??
    stringValue(releaseMetadata, "artifact_sha256");
  const runningDigest =
    stringValue(deployment, "running_artifact_sha256") ??
    stringValue(dockerApp, "artifact_sha256") ??
    stringValue(metadata, "running_artifact_sha256") ??
    (activeVersion === versionId
      ? stringValue(metadata, "artifact_sha256")
      : undefined);
  const publicUrl =
    stringValue(deployment, "public_url") ??
    stringValue(dockerApp, "public_url") ??
    stringValue(deployment, "auto_subdomain");
  const host =
    hostId && product === "docker_deploy"
      ? deploymentPayload(
          await client
            .apiGet<unknown>(
              `/api/v1/docker-deploy/hosts/${encodeURIComponent(hostId)}`,
            )
            .catch(() => ({})),
        )
      : {};
  return {
    versionId,
    inspection: {
      deployment_id: stringValue(deployment, "id") ?? deploymentId,
      deployment_name: stringValue(deployment, "name") ?? deploymentId,
      tenant_id: stringValue(deployment, "tenant_id") ?? null,
      workspace_id: stringValue(deployment, "workspace_id") ?? null,
      deployment_state: stringValue(deployment, "state") ?? "unknown",
      deployment_product: product,
      public_url: publicUrl ?? null,
      active_version_id: activeVersion ?? null,
      active_release_id: activeRelease ?? null,
      running_artifact_sha256: runningDigest ?? null,
      expected_artifact_sha256: expectedDigest ?? null,
      host_id: hostId ?? null,
      host_status:
        stringValue(host, "status") ??
        stringValue(metadata, "docker_deploy_host_status") ??
        (hostId ? "unknown" : null),
      appliance_status:
        stringValue(host, "appliance_status") ??
        stringValue(dockerApp, "last_health_status") ??
        stringValue(dockerApp, "status") ??
        null,
      database_attached:
        envNames.includes("DATABASE_URL") ||
        Boolean(
          stringValue(deployment, "database_id") ??
            stringValue(deployment, "linked_database_id") ??
            stringValue(metadata, "database_id") ??
            boolValue(metadata, "database_attached"),
        ),
      effective_env_names: envNames,
      healthy_connector_ids: (connectors.data ?? []).flatMap((connector) =>
        [
          stringValue(connector, "id"),
          stringValue(connector, "secret_id"),
          stringValue(connector, "name"),
          stringValue(connector, "provider"),
        ].filter((value): value is string => Boolean(value)),
      ),
      healthy_scheduled_job_ids: [],
    },
  };
}

async function verifyLinkedRelease(
  client: MiosaClient,
  dir: string,
  link: ApplicationLink,
  releaseId: string,
  contractPath?: string,
): Promise<{ receipt: ReleaseReceipt; receiptPath: string }> {
  const { inspection, versionId } = await inspectLinkedRelease(
    client,
    link.deploymentId,
    releaseId,
  );
  const receipt = await verifyApplicationRelease(
    {
      application: link.name,
      environment: link.environment,
      expected_release_id: releaseId,
      expected_version_id: versionId,
      expected_workspace_id: link.workspaceId,
      contract: loadAcceptanceContract(dir, contractPath),
    },
    {
      inspect: async () => inspection,
      probe: async (baseUrl, routePath) => {
        const started = Date.now();
        const url = new URL(routePath, baseUrl);
        const response = await request(url, {
          method: "GET",
          headersTimeout: 15_000,
          bodyTimeout: 15_000,
          maxRedirections: 0,
        });
        return {
          status: response.statusCode,
          body: await response.body.text(),
          content_type:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
          latency_ms: Date.now() - started,
        };
      },
    },
  );
  return { receipt, receiptPath: saveReleaseReceipt(dir, receipt) };
}

async function waitForActiveVersion(
  client: MiosaClient,
  deploymentId: string,
  versionId: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    const deployment = deploymentPayload(
      await client.apiGet<unknown>(
        `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
      ),
    );
    const dockerApp = record(deployment["docker_deploy_app"]);
    const active =
      stringValue(deployment, "active_version_id") ??
      stringValue(dockerApp, "deployment_version_id");
    if (active === versionId && stringValue(deployment, "state") === "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);
  throw new UserError(
    `Timed out waiting for immutable version ${versionId} to become active.`,
    "Run `miosa app recover <operation-id>` to inspect and resume safely.",
  );
}

function releaseArtifactDigest(release: Record<string, unknown>): string | undefined {
  const metadata = record(release["metadata"]);
  return (
    stringValue(release, "artifact_sha256") ??
    stringValue(release, "archive_sha256") ??
    stringValue(metadata, "artifact_sha256")
  );
}

async function activateLinkedRelease(input: {
  action: "promote" | "rollback";
  dir: string;
  link: ApplicationLink;
  releaseId: string;
  contractPath?: string;
  timeout: number;
  idempotencyKey?: string;
}): Promise<{
  operation: ReturnType<typeof createApplicationOperation>;
  receipt: ReleaseReceipt;
  receiptPath: string;
}> {
  const client = new MiosaClient(loadConfig());
  const release = await getRelease(
    client,
    input.link.deploymentId,
    input.releaseId,
  );
  const state = stringValue(release, "state");
  if (input.action === "promote" && state !== "ready" && state !== "active") {
    throw new UserError(
      `Release ${input.releaseId} is ${state ?? "unknown"}, expected ready.`,
      "Only a complete immutable release can be promoted.",
    );
  }
  const versionId = releaseVersionId(release);
  if (!versionId) {
    throw new UserError(
      `Release ${input.releaseId} has no immutable version ID.`,
    );
  }
  if (!releaseArtifactDigest(release)) {
    throw new UserError(
      `Release ${input.releaseId} has no artifact digest.`,
      "Publish must record artifact_sha256 before promotion is safe.",
    );
  }
  const current = deploymentPayload(
    await client.apiGet<unknown>(
      `/api/v1/deployments/${encodeURIComponent(input.link.deploymentId)}`,
    ),
  );
  const idempotencyKey =
    input.idempotencyKey ??
    applicationIdempotencyKey(
      input.action,
      input.link.deploymentId,
      input.releaseId,
      versionId,
    );
  let operation = createApplicationOperation(input.dir, {
    idempotency_key: idempotencyKey,
    action: input.action,
    deployment_id: input.link.deploymentId,
    release_id: input.releaseId,
    previous_version_id: stringValue(current, "active_version_id") ?? null,
    target_version_id: versionId,
    state: "pending",
  });
  try {
    const endpoint =
      input.action === "promote"
        ? `/api/v1/deployments/${encodeURIComponent(input.link.deploymentId)}/releases/${encodeURIComponent(input.releaseId)}/promote`
        : `/api/v1/deployments/${encodeURIComponent(input.link.deploymentId)}/rollback`;
    await client.apiPost<unknown>(
      endpoint,
      input.action === "rollback" ? { version_id: versionId } : undefined,
      { "Idempotency-Key": idempotencyKey },
    );
    await waitForActiveVersion(
      client,
      input.link.deploymentId,
      versionId,
      input.timeout,
    );
    const { receipt, receiptPath } = await verifyLinkedRelease(
      client,
      input.dir,
      input.link,
      input.releaseId,
      input.contractPath,
    );
    operation = updateApplicationOperation(input.dir, operation, {
      state: receipt.result === "verified" ? "succeeded" : "blocked",
      receipt_id: receipt.receipt_id,
      ...(receipt.result === "blocked"
        ? { error: "The activated release failed its acceptance contract." }
        : {}),
    });
    return { operation, receipt, receiptPath };
  } catch (error) {
    updateApplicationOperation(input.dir, operation, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function saveApplicationLink(dir: string, link: ApplicationLink): void {
  fs.writeFileSync(
    path.join(dir, ".miosa.json"),
    `${JSON.stringify(link, null, 2)}\n`,
    { mode: 0o600 },
  );
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
    .option("--docker-deploy", "Force App Engine production path")
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

  app
    .command("link")
    .argument("[path]", "Local app directory", ".")
    .description("Bind this source directory to one exact MIOSA application")
    .requiredOption("--app <id>", "Deployment/application ID")
    .option(
      "--environment <environment>",
      "Linked environment label",
      "production",
    )
    .option("--json", "Output compact machine-readable JSON")
    .action(
      async (
        inputPath: string,
        opts: { app: string; environment: string; json?: boolean },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new UserError(`Local app directory not found: ${dir}`);
          }
          const client = new MiosaClient(loadConfig());
          const raw = await client.apiGet<unknown>(
            `/api/v1/deployments/${encodeURIComponent(opts.app)}`,
          );
          const deployment = deploymentPayload(raw);
          const id = stringValue(deployment, "id");
          const name = stringValue(deployment, "name");
          if (!id || !name) {
            throw new UserError(
              "MIOSA returned an invalid deployment while linking the app.",
            );
          }
          const link: ApplicationLink = {
            version: 2,
            deploymentId: id,
            name,
            environment: opts.environment,
            ...(stringValue(deployment, "workspace_id")
              ? { workspaceId: stringValue(deployment, "workspace_id") }
              : {}),
            ...(stringValue(deployment, "project_id")
              ? { projectId: stringValue(deployment, "project_id") }
              : {}),
          };
          saveApplicationLink(dir, link);
          const result = {
            path: dir,
            deployment_id: id,
            application: name,
            environment: opts.environment,
            workspace_id: link.workspaceId ?? null,
            project_id: link.projectId ?? null,
            config: path.join(dir, ".miosa.json"),
          };
          if (isJsonMode(opts)) {
            printJson({ ok: true, data: result, error: null });
            return;
          }
          console.log(chalk.green(`Linked ${name} to ${dir}.`));
          console.log(chalk.dim(`Deployment: ${id}`));
          console.log(chalk.dim(`Environment: ${opts.environment}`));
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("pull")
    .argument("[path]", "Local app directory", ".")
    .description("Pull the linked application's configuration for local use")
    .option("--output <file>", "Output file relative to the app", ".env.local")
    .option("--overwrite", "Replace an existing output file")
    .option("--json", "Output configuration as JSON without writing a file")
    .action(
      async (
        inputPath: string,
        opts: { output: string; overwrite?: boolean; json?: boolean },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = requireApplicationLink(dir);
          const secrets = await fetchSecretValues(
            new MiosaClient(loadConfig()),
            link.deploymentId,
          );
          if (isJsonMode(opts)) {
            printJson({
              ok: true,
              data: {
                application: link.name,
                deployment_id: link.deploymentId,
                environment: link.environment,
                configuration: Object.fromEntries(
                  secrets.map(({ name, value }) => [name, value]),
                ),
              },
              error: null,
            });
            return;
          }
          const output = path.resolve(dir, opts.output);
          if (fs.existsSync(output) && !opts.overwrite) {
            throw new UserError(
              `${opts.output} already exists.`,
              "Pass --overwrite to replace it.",
            );
          }
          fs.writeFileSync(output, toDotenv(secrets), { mode: 0o600 });
          fs.chmodSync(output, 0o600);
          ensureGitignored(dir, path.relative(dir, output));
          console.log(
            chalk.green(
              `Pulled ${secrets.length} configuration values to ${path.relative(dir, output)}.`,
            ),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("preview")
    .argument("[path]", "Local app directory", ".")
    .description("Create a disposable preview from the current source")
    .option("--sandbox <id>", "Reuse an existing healthy sandbox")
    .option("--template <template>", "Sandbox template")
    .option("--name <name>", "Preview sandbox name")
    .option("--port <port>", "Application port", (value) => Number(value))
    .option("--start <command>", "Application start command")
    .option("--install-command <command>", "Dependency install command")
    .option("--no-install", "Skip dependency installation")
    .option("--timeout <seconds>", "Readiness timeout", (value) => Number(value), 600)
    .option("--probe-path <path>", "Readiness probe path", "/")
    .option("--json", "Output compact machine-readable JSON")
    .action(
      async (
        inputPath: string,
        opts: {
          sandbox?: string;
          template?: string;
          name?: string;
          port?: number;
          start?: string;
          installCommand?: string;
          install: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = loadLocalLink(dir);
          const result = await deploySandbox(dir, {
            ...opts,
            wait: true,
          });
          const candidate =
            link && result.preview_ready
              ? deploymentPayload(
                  await new MiosaClient(loadConfig()).apiPost<unknown>(
                    `/api/v1/deployments/${encodeURIComponent(link.deploymentId)}/publish`,
                    {
                      source_sandbox_id: result.sandbox_id,
                      output_path: "/workspace",
                      kind: "dynamic",
                      start_command: opts.start,
                      port: result.port,
                      health_check_path: opts.probePath,
                      promote: false,
                    },
                    {
                      "Idempotency-Key": `preview:${link.deploymentId}:${result.sandbox_id}`,
                    },
                  ),
                )
              : {};
          const release = record(candidate["release"]);
          const version = record(candidate["version"]);
          const payload = {
            schema_version: 1,
            application: link?.name ?? path.basename(dir),
            environment: "preview",
            sandbox_id: result.sandbox_id,
            release_id: stringValue(release, "id") ?? null,
            version_id: stringValue(version, "id") ?? null,
            artifact_sha256:
              stringValue(release, "artifact_sha256") ??
              stringValue(version, "artifact_sha256") ??
              null,
            url: result.preview_url,
            status: result.preview_ready ? "ready" : "blocked",
            promotion_allowed: false,
            next_actions: result.preview_ready
              ? stringValue(release, "id")
                ? [
                    `miosa app promote ${stringValue(release, "id")} . --yes --json`,
                  ]
                : [
                    "Run `miosa app link --app <deployment-id>` to create an immutable candidate release.",
                  ]
              : [
                  `miosa sandbox doctor ${result.sandbox_id} --port ${result.port} --json`,
                ],
          };
          if (isJsonMode(opts)) {
            printJson({ ok: result.preview_ready, data: payload, error: null });
            return;
          }
          console.log(
            result.preview_ready
              ? chalk.green(`Preview ready: ${result.preview_url}`)
              : chalk.yellow(`Preview is not ready: ${result.preview_url}`),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("verify <release-id>")
    .argument("[path]", "Local app directory", ".")
    .description(
      "Prove that one exact immutable release and its declared capabilities are live",
    )
    .option("--contract <file>", "Acceptance contract JSON path")
    .option("--json", "Output the stable release receipt as JSON")
    .action(
      async (
        releaseId: string,
        inputPath: string,
        opts: { contract?: string; json?: boolean },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = requireApplicationLink(dir);
          const { receipt, receiptPath } = await verifyLinkedRelease(
            new MiosaClient(loadConfig()),
            dir,
            link,
            releaseId,
            opts.contract,
          );
          if (isJsonMode(opts)) {
            printJson({
              ok: receipt.result === "verified",
              data: { ...receipt, receipt_path: receiptPath },
              error:
                receipt.result === "verified"
                  ? null
                  : {
                      code: "RELEASE_ACCEPTANCE_BLOCKED",
                      message:
                        "The exact release did not satisfy its acceptance contract.",
                    },
            });
            return;
          }
          console.log();
          console.log(
            receipt.result === "verified"
              ? chalk.green.bold("Release verified")
              : chalk.red.bold("Release blocked"),
          );
          for (const item of receipt.checks) {
            const marker =
              item.status === "pass"
                ? chalk.green("PASS")
                : item.status === "warning"
                  ? chalk.yellow("WARN")
                  : chalk.red("FAIL");
            console.log(`  ${marker} ${item.id}: ${item.message}`);
          }
          console.log(chalk.dim(`Receipt: ${receiptPath}`));
          if (receipt.result !== "verified") process.exitCode = 1;
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("promote <release-id>")
    .argument("[path]", "Local app directory", ".")
    .description(
      "Atomically promote one exact immutable release and verify it end to end",
    )
    .option("--contract <file>", "Acceptance contract JSON path")
    .option("--timeout <seconds>", "Activation timeout", (value) => Number(value), 600)
    .option("--idempotency-key <key>", "Reuse an operation idempotency key")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output the stable operation and release receipt")
    .action(
      async (
        releaseId: string,
        inputPath: string,
        opts: {
          contract?: string;
          timeout: number;
          idempotencyKey?: string;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = requireApplicationLink(dir);
          if (!opts.yes) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `Promote exact release ${releaseId} to ${link.name} (${link.environment})?`,
                default: false,
              },
            ]);
            if (!ok) return;
          }
          const result = await activateLinkedRelease({
            action: "promote",
            dir,
            link,
            releaseId,
            contractPath: opts.contract,
            timeout: opts.timeout,
            idempotencyKey: opts.idempotencyKey,
          });
          if (isJsonMode(opts)) {
            printJson({
              ok: result.receipt.result === "verified",
              data: {
                operation: result.operation,
                receipt: result.receipt,
                receipt_path: result.receiptPath,
              },
              error:
                result.receipt.result === "verified"
                  ? null
                  : {
                      code: "RELEASE_ACCEPTANCE_BLOCKED",
                      message: "Promotion completed but acceptance was blocked.",
                    },
            });
            return;
          }
          console.log(
            result.receipt.result === "verified"
              ? chalk.green.bold(
                  `Release ${releaseId} is active and verified.`,
                )
              : chalk.red.bold(
                  `Release ${releaseId} activated but failed acceptance.`,
                ),
          );
          console.log(chalk.dim(`Operation: ${result.operation.operation_id}`));
          console.log(chalk.dim(`Receipt: ${result.receiptPath}`));
          if (result.receipt.result !== "verified") process.exitCode = 1;
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("rollback <release-id>")
    .argument("[path]", "Local app directory", ".")
    .description("Rollback code to one exact immutable release and verify it")
    .option("--contract <file>", "Acceptance contract JSON path")
    .option("--timeout <seconds>", "Activation timeout", (value) => Number(value), 600)
    .option("--idempotency-key <key>", "Reuse an operation idempotency key")
    .option(
      "--acknowledge-data-risk",
      "Acknowledge that code rollback does not reverse database migrations",
    )
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Output the stable operation and release receipt")
    .action(
      async (
        releaseId: string,
        inputPath: string,
        opts: {
          contract?: string;
          timeout: number;
          idempotencyKey?: string;
          acknowledgeDataRisk?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = requireApplicationLink(dir);
          const client = new MiosaClient(loadConfig());
          const release = await getRelease(
            client,
            link.deploymentId,
            releaseId,
          );
          const migrationCompatibility =
            stringValue(release, "migration_compatibility") ??
            stringValue(record(release["metadata"]), "migration_compatibility");
          if (
            migrationCompatibility === "incompatible" &&
            !opts.acknowledgeDataRisk
          ) {
            throw new UserError(
              "Rollback is blocked because this release declares incompatible database migrations.",
              "Restore or migrate the database first, or pass --acknowledge-data-risk after reviewing the impact.",
            );
          }
          if (!opts.yes) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `Rollback ${link.name} to exact release ${releaseId}? Database migrations are not reversed.`,
                default: false,
              },
            ]);
            if (!ok) return;
          }
          const result = await activateLinkedRelease({
            action: "rollback",
            dir,
            link,
            releaseId,
            contractPath: opts.contract,
            timeout: opts.timeout,
            idempotencyKey: opts.idempotencyKey,
          });
          if (isJsonMode(opts)) {
            printJson({
              ok: result.receipt.result === "verified",
              data: {
                operation: result.operation,
                receipt: result.receipt,
                receipt_path: result.receiptPath,
              },
              error: result.receipt.result === "verified" ? null : {
                code: "ROLLBACK_ACCEPTANCE_BLOCKED",
                message: "Rollback completed but acceptance was blocked.",
              },
            });
            return;
          }
          console.log(
            chalk.green.bold(
              `Rollback to ${releaseId} is active and verified.`,
            ),
          );
          console.log(chalk.dim(`Operation: ${result.operation.operation_id}`));
          console.log(chalk.dim(`Receipt: ${result.receiptPath}`));
        } catch (err) {
          handleError(err);
        }
      },
    );

  app
    .command("recover <operation-id>")
    .argument("[path]", "Local app directory", ".")
    .description("Inspect or safely resume an interrupted app operation")
    .option("--resume", "Retry the operation with its original idempotency key")
    .option("--contract <file>", "Acceptance contract JSON path")
    .option("--timeout <seconds>", "Activation timeout", (value) => Number(value), 600)
    .option("--json", "Output machine-readable operation state")
    .action(
      async (
        operationId: string,
        inputPath: string,
        opts: {
          resume?: boolean;
          contract?: string;
          timeout: number;
          json?: boolean;
        },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const existing = loadApplicationOperation(dir, operationId);
          if (!existing) {
            throw new UserError(`Application operation not found: ${operationId}`);
          }
          if (!opts.resume || existing.state === "succeeded") {
            if (isJsonMode(opts)) {
              printJson({ ok: true, data: existing, error: null });
            } else {
              console.log(JSON.stringify(existing, null, 2));
            }
            return;
          }
          const result = await activateLinkedRelease({
            action: existing.action,
            dir,
            link: requireApplicationLink(dir),
            releaseId: existing.release_id,
            contractPath: opts.contract,
            timeout: opts.timeout,
            idempotencyKey: existing.idempotency_key,
          });
          if (isJsonMode(opts)) {
            printJson({ ok: true, data: result, error: null });
          } else {
            console.log(
              chalk.green(
                `Operation resumed and ${result.receipt.result}.`,
              ),
            );
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
