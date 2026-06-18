import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { createOsaPlan } from "./plans.js";
import { publishOsaProject, type OsaProjectPublishResult } from "./projects.js";
import type { OsaExecutionPlan } from "./types.js";

export interface DeployOsaProjectOptions {
  target?: string;
  workspace?: string;
  projectId?: string;
  osaProjectId?: string;
  deployTarget?: string;
  sandbox?: string;
  computer?: string;
  source?: string;
  wait?: boolean;
  waitTimeout?: string;
  waitPollIntervalMs?: number;
}

export interface ListOsaDeploymentsOptions {
  status?: string;
  limit?: string;
}

export interface OsaDeploymentRequest {
  deploy_target: string;
  source: string;
  deployment_plan: OsaExecutionPlan;
  runtime_profile: OsaExecutionPlan["runtimeProfile"];
  metadata: {
    osa_project: true;
    cli_command: "miosa osa deploy";
  };
  sandbox_id?: string;
  computer_id?: string;
}

export interface OsaDeploymentResult {
  plan: OsaExecutionPlan;
  osaProjectId: string;
  publish?: OsaProjectPublishResult;
  request: OsaDeploymentRequest;
  deployment: Record<string, unknown>;
}

const TERMINAL_STATUSES = new Set(["deployed", "failed", "canceled"]);

export async function deployOsaProject(
  options: DeployOsaProjectOptions = {},
): Promise<OsaDeploymentResult> {
  const plan = createOsaPlan({
    kind: "deploy",
    target: options.target,
    runtimeTarget: options.computer
      ? "computer"
      : options.sandbox
        ? "sandbox"
        : options.deployTarget,
  });
  const deployTarget = options.computer
    ? "computer"
    : options.sandbox
      ? "sandbox"
      : options.deployTarget ?? plan.target ?? "miosa-cloud";

  const publish = options.osaProjectId
    ? undefined
    : await publishOsaProject({
        target: options.target,
        workspace: options.workspace,
        projectId: options.projectId,
        source: options.source ?? "miosa-cli",
      });

  const osaProjectId = options.osaProjectId ?? stringField(publish?.project, "id");
  if (!osaProjectId) {
    throw new Error("OSA publish response did not include a project id.");
  }

  const request: OsaDeploymentRequest = {
    deploy_target: deployTarget,
    source: options.source ?? "miosa-cli",
    deployment_plan: plan,
    runtime_profile: plan.runtimeProfile,
    metadata: {
      osa_project: true,
      cli_command: "miosa osa deploy",
    },
  };

  if (options.sandbox) request.sandbox_id = options.sandbox;
  if (options.computer) request.computer_id = options.computer;

  const client = new MiosaClient(loadConfig());
  const response = await client.apiPost<unknown>(
    `/api/v1/osa-projects/${encodeURIComponent(osaProjectId)}/deployments`,
    request,
  );
  let deployment = unwrapData(response);

  if (options.wait) {
    const deploymentId = stringField(deployment, "id");
    if (!deploymentId) {
      throw new Error("OSA deployment response did not include a deployment id.");
    }
    deployment = await waitForOsaDeployment(client, osaProjectId, deploymentId, {
      timeoutSeconds: parsePositiveInt(options.waitTimeout, 600),
      pollIntervalMs: options.waitPollIntervalMs ?? 1000,
    });
  }

  return {
    plan,
    osaProjectId,
    ...(publish ? { publish } : {}),
    request,
    deployment,
  };
}

export async function getOsaDeployment(
  osaProjectId: string,
  deploymentId: string,
): Promise<Record<string, unknown>> {
  const client = new MiosaClient(loadConfig());
  const payload = await client.apiGet<unknown>(
    `/api/v1/osa-projects/${encodeURIComponent(osaProjectId)}/deployments/${encodeURIComponent(
      deploymentId,
    )}`,
  );
  return unwrapData(payload);
}

export async function listOsaDeployments(
  osaProjectId: string,
  options: ListOsaDeploymentsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", options.limit);

  const client = new MiosaClient(loadConfig());
  const payload = await client.apiGet<unknown>(
    `/api/v1/osa-projects/${encodeURIComponent(osaProjectId)}/deployments${queryString(params)}`,
  );

  if (isRecord(payload) && Array.isArray(payload["data"])) {
    return payload["data"].filter(isRecord);
  }
  return [];
}

export async function retryOsaDeployment(
  osaProjectId: string,
  deploymentId: string,
): Promise<Record<string, unknown>> {
  return deploymentAction(osaProjectId, deploymentId, "retry");
}

export async function cancelOsaDeployment(
  osaProjectId: string,
  deploymentId: string,
): Promise<Record<string, unknown>> {
  return deploymentAction(osaProjectId, deploymentId, "cancel");
}

async function waitForOsaDeployment(
  client: MiosaClient,
  osaProjectId: string,
  deploymentId: string,
  opts: { timeoutSeconds: number; pollIntervalMs: number },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;

  while (true) {
    const payload = await client.apiGet<unknown>(
      `/api/v1/osa-projects/${encodeURIComponent(osaProjectId)}/deployments/${encodeURIComponent(
        deploymentId,
      )}`,
    );
    const deployment = unwrapData(payload);
    const status = stringField(deployment, "status");

    if (status && TERMINAL_STATUSES.has(status)) return deployment;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for OSA deployment ${deploymentId}.`);
    }

    await sleep(opts.pollIntervalMs);
  }
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid --wait-timeout value. Use a positive number of seconds.");
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deploymentAction(
  osaProjectId: string,
  deploymentId: string,
  action: "retry" | "cancel",
): Promise<Record<string, unknown>> {
  const client = new MiosaClient(loadConfig());
  const payload = await client.apiPost<unknown>(
    `/api/v1/osa-projects/${encodeURIComponent(osaProjectId)}/deployments/${encodeURIComponent(
      deploymentId,
    )}/${action}`,
  );
  return unwrapData(payload);
}

function queryString(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : "";
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (isRecord(payload) && isRecord(payload["data"])) {
    return payload["data"] as Record<string, unknown>;
  }
  return isRecord(payload) ? payload : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
