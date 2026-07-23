import type { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  approvePlan,
  assertPlanApplicable,
  contractFingerprint,
  createSavedPlan,
  detectContractDrift,
  loadPlan,
  resolveApplicationContract,
  savePlan,
  type SavedApplicationPlan,
} from "../app-contract.js";
import { loadAppManifest, validateProjectManifest } from "../app-manifest.js";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import {
  activateLinkedRelease,
  getRelease,
  requireApplicationLink,
} from "./app.js";
import { handleError, isJsonMode, printJson } from "./util.js";

type JsonOptions = { json?: boolean };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function payload(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const data = record(outer["data"]);
  return Object.keys(data).length > 0 ? data : outer;
}

function stringValue(value: unknown, key: string): string | undefined {
  const found = record(value)[key];
  return typeof found === "string" && found.trim() ? found.trim() : undefined;
}

function output(opts: JsonOptions, data: unknown, message?: string): void {
  if (isJsonMode(opts)) {
    printJson({ ok: true, data, error: null });
  } else if (message) {
    console.log(message);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function releaseIdentity(release: Record<string, unknown>): {
  versionId: string;
  digest: string;
} {
  const metadata = record(release["metadata"]);
  const versionId =
    stringValue(release, "deployment_version_id") ??
    stringValue(release, "version_id");
  const digest =
    stringValue(release, "artifact_sha256") ??
    stringValue(release, "archive_sha256") ??
    stringValue(metadata, "artifact_sha256");
  if (!versionId || !digest) {
    throw new UserError(
      "The candidate is missing an immutable version ID or artifact digest.",
    );
  }
  return { versionId, digest };
}

function actorName(value?: string): string {
  return (
    value ??
    process.env["MIOSA_APPROVER"] ??
    process.env["USER"] ??
    os.userInfo().username
  );
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

function planPath(appDir: string, plan: SavedApplicationPlan): string {
  return path.join(appDir, ".miosa", "plans", `${plan.plan_id}.json`);
}

async function assertPrePromotionGates(
  client: MiosaClient,
  plan: SavedApplicationPlan,
): Promise<void> {
  const [release, deployment, environment] = await Promise.all([
    getRelease(client, plan.scope.deployment_id, plan.release.id),
    deploymentState(client, plan.scope.deployment_id),
    client.apiGet<{ data?: Array<{ name?: string }> }>(
      `/api/v1/deployments/${encodeURIComponent(plan.scope.deployment_id)}/env`,
    ),
  ]);
  const identity = releaseIdentity(release);
  const releaseMetadata = record(release["metadata"]);
  const deploymentMetadata = record(deployment["metadata"]);
  const failures: string[] = [];
  if (
    identity.versionId !== plan.release.version_id ||
    identity.digest !== plan.release.artifact_sha256
  ) {
    failures.push("candidate release identity no longer matches the saved plan");
  }
  const environmentNames = new Set(
    (environment.data ?? [])
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name)),
  );
  for (const secret of plan.capabilities.secrets) {
    if (secret.required !== false && !environmentNames.has(secret.name)) {
      failures.push(`required secret ${secret.name} is not bound`);
    }
  }
  if (
    plan.capabilities.database?.required &&
    !environmentNames.has("DATABASE_URL") &&
    !stringValue(deployment, "database_id") &&
    !stringValue(deploymentMetadata, "database_id")
  ) {
    failures.push("required database is not attached");
  }
  if (
    plan.capabilities.database?.migration?.required &&
    releaseMetadata["migration_verified"] !== true &&
    stringValue(releaseMetadata, "migration_status") !== "succeeded"
  ) {
    failures.push("required database migration evidence is missing");
  }
  for (const connector of plan.capabilities.connectors) {
    if (connector.required === false) continue;
    const response = payload(
      await client
        .apiPost<unknown>(
          `/api/v1/deployments/${encodeURIComponent(plan.scope.deployment_id)}/connectors/preflight`,
          { connector: connector.id },
        )
        .catch(() => ({})),
    );
    if (record(response["status"])["bound"] !== true) {
      failures.push(`required connector ${connector.id} is not bound`);
    }
  }
  const jobs = [
    deployment["scheduled_jobs"],
    deploymentMetadata["scheduled_jobs"],
  ].flatMap((value) => (Array.isArray(value) ? value : []));
  const healthyJobs = new Set(
    jobs.flatMap((candidate) => {
      const job = record(candidate);
      const id = stringValue(job, "id") ?? stringValue(job, "name");
      const healthy =
        job["enabled"] !== false &&
        job["paused"] !== true &&
        stringValue(job, "status") !== "failed" &&
        stringValue(job, "last_run_status") !== "failed";
      return id && healthy ? [id] : [];
    }),
  );
  for (const job of plan.capabilities.jobs) {
    if (job.required !== false && !healthyJobs.has(job.id)) {
      failures.push(`required job ${job.id} is not registered and healthy`);
    }
  }
  const suppliedBusinessEvidence = new Set(
    Array.isArray(releaseMetadata["business_capability_evidence"])
      ? releaseMetadata["business_capability_evidence"].filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  for (const capability of plan.capabilities.business) {
    if (
      capability.required !== false &&
      !suppliedBusinessEvidence.has(capability.id)
    ) {
      failures.push(`business capability ${capability.id} lacks candidate evidence`);
    }
  }
  if (failures.length > 0) {
    throw new UserError(
      `Promotion gates blocked ${plan.release.id}: ${failures.join("; ")}.`,
      "Repair the declared binding or attach candidate evidence, then create a new immutable plan.",
    );
  }
}

async function deploymentState(
  client: MiosaClient,
  deploymentId: string,
): Promise<Record<string, unknown>> {
  return payload(
    await client.apiGet<unknown>(
      `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
    ),
  );
}

export function register(program: Command): void {
  const blueprint = program
    .command("blueprint")
    .description("Validate and inspect miosa.app.yml capability blueprints");

  blueprint
    .command("validate")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      try {
        const dir = path.resolve(inputPath);
        const loaded = loadAppManifest(dir);
        if (!loaded) throw new UserError("miosa.app.yml was not found.");
        const issues = validateProjectManifest(loaded.manifest);
        const result = {
          path: loaded.path,
          valid: issues.length === 0,
          issues,
          capabilities: loaded.manifest.capabilities ?? null,
          policy: loaded.manifest.policy ?? null,
        };
        if (issues.length > 0) process.exitCode = 1;
        output(opts, result);
      } catch (error) {
        handleError(error);
      }
    });

  blueprint
    .command("show")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      try {
        const dir = path.resolve(inputPath);
        const link = requireApplicationLink(dir);
        output(opts, resolveApplicationContract(dir, link));
      } catch (error) {
        handleError(error);
      }
    });

  const changes = program
    .command("changes")
    .description("Create, approve, inspect, and exactly apply immutable release plans");

  changes
    .command("plan <release-id>")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action(async (releaseId: string, inputPath: string, opts: JsonOptions) => {
      try {
        const dir = path.resolve(inputPath);
        const link = requireApplicationLink(dir);
        const contract = resolveApplicationContract(dir, link);
        const client = new MiosaClient(loadConfig());
        const [release, deployment] = await Promise.all([
          getRelease(client, link.deploymentId, releaseId),
          deploymentState(client, link.deploymentId),
        ]);
        const identity = releaseIdentity(release);
        let plan = createSavedPlan(dir, {
          scope: contract.scope,
          release: {
            id: releaseId,
            version_id: identity.versionId,
            artifact_sha256: identity.digest,
            rollback_version_id:
              stringValue(deployment, "active_version_id") ?? null,
          },
          desired_state: {
            route: {
              public_url:
                stringValue(deployment, "public_url") ??
                stringValue(record(deployment["docker_deploy_app"]), "public_url") ??
                stringValue(deployment, "auto_subdomain") ??
                null,
            },
            archive: { artifact_sha256: identity.digest },
            host: {
              id:
                stringValue(deployment, "docker_deploy_host_id") ??
                stringValue(
                  record(deployment["docker_deploy_app"]),
                  "docker_deploy_host_id",
                ) ??
                null,
              status: "active",
              appliance_status: "healthy",
            },
            database: {
              attached: contract.capabilities.database?.required === true,
            },
            connectors: {
              ids: contract.capabilities.connectors
                .filter((connector) => connector.required !== false)
                .map((connector) => connector.id)
                .sort(),
            },
            jobs: {
              ids: contract.capabilities.jobs
                .filter((job) => job.required !== false)
                .map((job) => job.id)
                .sort(),
            },
            policy: { fingerprint: contractFingerprint(contract.policy) },
          },
          capabilities: contract.capabilities,
          policy: contract.policy,
        });
        const durable = payload(
          await client.apiPost<unknown>(
            `/api/v1/deployments/${encodeURIComponent(link.deploymentId)}/plans`,
            { plan },
            { "Idempotency-Key": `plan:${plan.fingerprint}` },
          ),
        );
        const durableId = stringValue(durable, "id");
        if (!durableId) {
          throw new UserError(
            "The control plane did not persist the immutable application plan.",
          );
        }
        plan = { ...plan, control_plane_plan_id: durableId };
        savePlan(dir, plan);
        output(opts, { plan, plan_path: planPath(dir, plan) });
      } catch (error) {
        handleError(error);
      }
    });

  changes
    .command("approve <plan-id>")
    .argument("[path]", "Application directory", ".")
    .option("--actor <identity>", "Approval actor identity")
    .option("--json", "Output stable JSON")
    .action(
      async (
        planId: string,
        inputPath: string,
        opts: JsonOptions & { actor?: string },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          let plan = approvePlan(
            dir,
            loadPlan(dir, planId),
            actorName(opts.actor),
          );
          if (!plan.control_plane_plan_id) {
            throw new UserError(
              `Saved plan ${plan.plan_id} has no durable control-plane record.`,
              "Create a new plan with `miosa changes plan`.",
            );
          }
          const controlPlanePlanId = plan.control_plane_plan_id;
          const client = new MiosaClient(loadConfig());
          const durable = payload(
            await client.apiPost<unknown>(
              `/api/v1/application-plans/${encodeURIComponent(controlPlanePlanId)}/approve`,
              {
                fingerprint: plan.fingerprint,
                actor: actorName(opts.actor),
              },
              { "Idempotency-Key": `approve:${plan.fingerprint}:${actorName(opts.actor)}` },
            ),
          );
          plan = { ...plan, control_plane_plan_id: stringValue(durable, "id") ?? plan.control_plane_plan_id };
          savePlan(dir, plan);
          output(opts, { plan, plan_path: planPath(dir, plan) });
        } catch (error) {
          handleError(error);
        }
      },
    );

  changes
    .command("show <plan-id>")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((planId: string, inputPath: string, opts: JsonOptions) => {
      try {
        output(opts, loadPlan(path.resolve(inputPath), planId));
      } catch (error) {
        handleError(error);
      }
    });

  changes
    .command("apply <plan-id>")
    .argument("[path]", "Application directory", ".")
    .option("--timeout <seconds>", "Activation timeout", Number, 600)
    .option("--json", "Output stable JSON")
    .action(
      async (
        planId: string,
        inputPath: string,
        opts: JsonOptions & { timeout: number },
      ) => {
        try {
          const dir = path.resolve(inputPath);
          const link = requireApplicationLink(dir);
          const contract = resolveApplicationContract(dir, link);
          let plan = loadPlan(dir, planId);
          assertPlanApplicable(plan, contract.scope);
          if (!plan.control_plane_plan_id) {
            throw new UserError(
              `Saved plan ${plan.plan_id} has no durable control-plane record.`,
            );
          }
          const controlPlanePlanId = plan.control_plane_plan_id;
          const client = new MiosaClient(loadConfig());
          await assertPrePromotionGates(
            client,
            plan,
          );
          await client.apiPost<unknown>(
            `/api/v1/application-plans/${encodeURIComponent(controlPlanePlanId)}/apply`,
            { fingerprint: plan.fingerprint },
            { "Idempotency-Key": `apply:${plan.fingerprint}` },
          );
          plan = { ...plan, state: "applying", updated_at: new Date().toISOString() };
          savePlan(dir, plan);
          try {
            const result = await activateLinkedRelease({
              action: "promote",
              dir,
              link,
              releaseId: plan.release.id,
              timeout: opts.timeout,
              idempotencyKey: `plan:${plan.fingerprint}`,
              verificationEvidence: {
                migration_verified: true,
                policy_verified: true,
              },
            });
            plan = {
              ...plan,
              state:
                result.receipt.result === "verified" ? "verified" : "blocked",
              updated_at: new Date().toISOString(),
            };
            savePlan(dir, plan);
            await client.apiPost<unknown>(
              `/api/v1/application-plans/${encodeURIComponent(controlPlanePlanId)}/complete`,
              {
                result: result.receipt.result,
                receipt: result.receipt,
              },
              { "Idempotency-Key": `complete:${plan.fingerprint}` },
            );
            output(opts, { plan, ...result });
          } catch (error) {
            savePlan(dir, {
              ...plan,
              state: "failed",
              updated_at: new Date().toISOString(),
            });
            await client
              .apiPost<unknown>(
                `/api/v1/application-plans/${encodeURIComponent(controlPlanePlanId)}/complete`,
                {
                  result: "failed",
                  receipt: {
                    error: error instanceof Error ? error.message : String(error),
                  },
                },
                { "Idempotency-Key": `complete:${plan.fingerprint}:failed` },
              )
              .catch(() => undefined);
            throw error;
          }
        } catch (error) {
          handleError(error);
        }
      },
    );

  const placement = program
    .command("placement")
    .description("Inspect the exact runtime placement for a linked application");
  placement
    .command("show")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action(async (inputPath: string, opts: JsonOptions) => {
      try {
        const link = requireApplicationLink(path.resolve(inputPath));
        const deployment = await deploymentState(
          new MiosaClient(loadConfig()),
          link.deploymentId,
        );
        output(opts, {
          deployment_id: link.deploymentId,
          product: stringValue(deployment, "deployment_product") ?? null,
          host_id: stringValue(deployment, "docker_deploy_host_id") ?? null,
          active_release_id: stringValue(deployment, "active_release_id") ?? null,
          active_version_id: stringValue(deployment, "active_version_id") ?? null,
          public_url: stringValue(deployment, "public_url") ?? null,
          state: stringValue(deployment, "state") ?? "unknown",
        });
      } catch (error) {
        handleError(error);
      }
    });

  const drift = program
    .command("drift")
    .description("Detect and report drift from an approved immutable plan");
  drift
    .command("detect <plan-id>")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action(async (planId: string, inputPath: string, opts: JsonOptions) => {
      try {
        const dir = path.resolve(inputPath);
        const plan = loadPlan(dir, planId);
        const client = new MiosaClient(loadConfig());
        const [deployment, environment] = await Promise.all([
          deploymentState(client, plan.scope.deployment_id),
          client.apiGet<{ data?: Array<{ name?: string }> }>(
            `/api/v1/deployments/${encodeURIComponent(plan.scope.deployment_id)}/env`,
          ),
        ]);
        const currentContract = resolveApplicationContract(
          dir,
          requireApplicationLink(dir),
        );
        const hostId =
          stringValue(deployment, "docker_deploy_host_id") ??
          stringValue(
            record(deployment["docker_deploy_app"]),
            "docker_deploy_host_id",
          );
        const host = hostId
          ? payload(
              await client
                .apiGet<unknown>(
                  `/api/v1/docker-deploy/hosts/${encodeURIComponent(hostId)}`,
                )
                .catch(() => ({})),
            )
          : {};
        const connectorIds = (
          await Promise.all(
            plan.capabilities.connectors.map(async (connector) => {
              const response = payload(
                await client
                  .apiPost<unknown>(
                    `/api/v1/deployments/${encodeURIComponent(plan.scope.deployment_id)}/connectors/preflight`,
                    { connector: connector.id },
                  )
                  .catch(() => ({})),
              );
              return record(response["status"])["bound"] === true
                ? connector.id
                : null;
            }),
          )
        )
          .filter((id): id is string => Boolean(id))
          .sort();
        const deploymentMetadata = record(deployment["metadata"]);
        const dockerApp = record(deployment["docker_deploy_app"]);
        const runningDigest =
          stringValue(deployment, "running_artifact_sha256") ??
          stringValue(dockerApp, "artifact_sha256") ??
          stringValue(deploymentMetadata, "running_artifact_sha256") ??
          null;
        const actualJobs = [
          deployment["scheduled_jobs"],
          deploymentMetadata["scheduled_jobs"],
        ]
          .flatMap((value) => (Array.isArray(value) ? value : []))
          .flatMap((candidate) => {
            const job = record(candidate);
            const id = stringValue(job, "id") ?? stringValue(job, "name");
            const healthy =
              job["enabled"] !== false &&
              job["paused"] !== true &&
              stringValue(job, "status") !== "failed" &&
              stringValue(job, "last_run_status") !== "failed";
            return id && healthy ? [id] : [];
          })
          .sort();
        const publicUrl =
          stringValue(deployment, "public_url") ??
          stringValue(record(deployment["docker_deploy_app"]), "public_url") ??
          stringValue(deployment, "auto_subdomain") ??
          null;
        const envNames = new Set(
          (environment.data ?? [])
            .map((item) => item.name)
            .filter((name): name is string => Boolean(name)),
        );
        const actual = {
          scope: currentContract.scope,
          release: {
            id: stringValue(deployment, "active_release_id") ?? null,
            version_id: stringValue(deployment, "active_version_id") ?? null,
            artifact_sha256:
              runningDigest,
          },
          desired_state: {
            route: { public_url: publicUrl },
            archive: {
              artifact_sha256: runningDigest,
            },
            host: {
              id: hostId ?? null,
              status: stringValue(host, "status") ?? (hostId ? "unknown" : "active"),
              appliance_status:
                stringValue(host, "appliance_status") ??
                (hostId ? "unknown" : "healthy"),
            },
            database: {
              attached:
                envNames.has("DATABASE_URL") ||
                Boolean(
                  stringValue(deployment, "database_id") ??
                    stringValue(deploymentMetadata, "database_id"),
                ),
            },
            connectors: { ids: connectorIds },
            jobs: { ids: actualJobs },
            policy: {
              fingerprint: contractFingerprint(currentContract.policy),
            },
          },
        };
        const expected = {
          scope: plan.scope,
          release: {
            id: plan.release.id,
            version_id: plan.release.version_id,
            artifact_sha256: plan.release.artifact_sha256,
          },
          desired_state: plan.desired_state,
        };
        const items = detectContractDrift(expected, actual);
        output(opts, {
          plan_id: plan.plan_id,
          drifted: items.length > 0,
          items,
          reconciliation:
            items.length === 0
              ? null
              : `miosa changes apply ${plan.plan_id} . --json`,
        });
        if (items.length > 0) process.exitCode = 2;
      } catch (error) {
        handleError(error);
      }
    });
  drift
    .command("reconcile <plan-id>")
    .description("Print the exact approved reconciliation action")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((planId: string, inputPath: string, opts: JsonOptions) => {
      try {
        const plan = loadPlan(path.resolve(inputPath), planId);
        output(opts, {
          automatic: false,
          reason: "Reconciliation is a production mutation and requires exact apply.",
          command: `miosa changes apply ${plan.plan_id} . --json`,
        });
      } catch (error) {
        handleError(error);
      }
    });

  const policy = program
    .command("policy")
    .description("Evaluate capability and approval policy");
  policy
    .command("check")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      try {
        const dir = path.resolve(inputPath);
        const contract = resolveApplicationContract(
          dir,
          requireApplicationLink(dir),
        );
        output(opts, {
          allowed:
            contract.policy.allowed_environments.length === 0 ||
            contract.policy.allowed_environments.includes(
              contract.scope.environment,
            ),
          scope: contract.scope,
          policy: contract.policy,
        });
      } catch (error) {
        handleError(error);
      }
    });

  const evidence = program
    .command("evidence")
    .description("Inspect durable release receipts and verification evidence");
  evidence
    .command("list")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      const dir = path.join(path.resolve(inputPath), ".miosa", "receipts");
      output(opts, { receipts: listJsonFiles(dir), path: dir });
    });
  evidence
    .command("show <receipt-id>")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((receiptId: string, inputPath: string, opts: JsonOptions) => {
      try {
        const file = path.join(
          path.resolve(inputPath),
          ".miosa",
          "receipts",
          `${receiptId}.json`,
        );
        if (!fs.existsSync(file)) throw new UserError(`Receipt not found: ${receiptId}`);
        output(opts, JSON.parse(fs.readFileSync(file, "utf8")));
      } catch (error) {
        handleError(error);
      }
    });

  const incidents = program
    .command("incidents")
    .description("Inspect failed or blocked local deployment operations");
  incidents
    .command("list")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      const dir = path.join(path.resolve(inputPath), ".miosa", "operations");
      const incidents = listJsonFiles(dir)
        .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))
        .filter((item) => item.state === "failed" || item.state === "blocked");
      output(opts, { incidents, count: incidents.length });
    });

  const wait = program
    .command("wait")
    .description("Wait for a durable server operation to reach a terminal state");
  wait
    .command("operation <operation-id>")
    .option("--timeout <seconds>", "Wait timeout", Number, 600)
    .option("--json", "Output stable JSON")
    .action(
      async (
        operationId: string,
        opts: JsonOptions & { timeout: number },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const deadline = Date.now() + opts.timeout * 1_000;
          let operation: Record<string, unknown> = {};
          do {
            operation = payload(
              await client.apiGet<unknown>(
                `/api/v1/operations/${encodeURIComponent(operationId)}`,
              ),
            );
            const status = stringValue(operation, "status");
            if (["succeeded", "failed", "canceled"].includes(status ?? "")) {
              output(opts, operation);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          } while (Date.now() < deadline);
          throw new UserError(`Timed out waiting for operation ${operationId}.`);
        } catch (error) {
          handleError(error);
        }
      },
    );

  const memory = program
    .command("memory")
    .description("Record and inspect local operator decisions for an application");
  memory
    .command("record <message>")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((message: string, inputPath: string, opts: JsonOptions) => {
      const dir = path.join(path.resolve(inputPath), ".miosa");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, "memory.jsonl");
      const entry = {
        recorded_at: new Date().toISOString(),
        actor: actorName(),
        message,
      };
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      output(opts, entry, chalk.green("Decision recorded."));
    });
  memory
    .command("list")
    .argument("[path]", "Application directory", ".")
    .option("--json", "Output stable JSON")
    .action((inputPath: string, opts: JsonOptions) => {
      const file = path.join(path.resolve(inputPath), ".miosa", "memory.jsonl");
      const entries = fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      output(opts, { entries });
    });
}
