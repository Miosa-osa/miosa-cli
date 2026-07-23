import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UserError } from "./errors.js";

export interface RouteRequirement {
  id: string;
  path: string;
  expected_status: number[];
  body_contains?: string[];
  content_type?: string;
  required?: boolean;
}

export interface AcceptanceContract {
  schema_version: 1;
  routes: RouteRequirement[];
  required_env?: string[];
  database?: {
    required: boolean;
    health_path?: string;
  };
  connectors?: Array<{ id: string; required?: boolean }>;
  scheduled_jobs?: Array<{ id: string; required?: boolean }>;
}

export interface ReleaseInspection {
  deployment_id: string;
  deployment_name: string;
  tenant_id: string | null;
  workspace_id: string | null;
  deployment_state: string;
  deployment_product: string;
  public_url: string | null;
  active_version_id: string | null;
  active_release_id: string | null;
  running_artifact_sha256: string | null;
  expected_artifact_sha256: string | null;
  host_id: string | null;
  host_status: string | null;
  appliance_status: string | null;
  database_attached: boolean;
  effective_env_names: string[];
  healthy_connector_ids: string[];
  healthy_scheduled_job_ids: string[];
}

export interface ProbeResponse {
  status: number;
  body: string;
  content_type: string | null;
  latency_ms?: number;
}

export interface ReleaseVerificationAdapter {
  inspect(): Promise<ReleaseInspection>;
  probe(url: string, path: string): Promise<ProbeResponse>;
}

export interface VerificationCheck {
  id: string;
  status: "pass" | "fail" | "warning" | "not_required";
  message: string;
  details?: Record<string, unknown>;
  recovery?: string[];
}

export interface ReleaseReceipt {
  schema_version: 1;
  receipt_id: string;
  application: string;
  environment: string;
  result: "verified" | "blocked";
  promotion_allowed: boolean;
  deployment: {
    id: string;
    name: string;
    product: string;
    url: string | null;
    host_id: string | null;
    tenant_id: string | null;
    workspace_id: string | null;
  };
  release: {
    id: string;
    version_id: string;
    artifact_sha256: string | null;
  };
  checks: VerificationCheck[];
  next_actions: string[];
  verified_at: string;
}

export interface VerifyApplicationReleaseInput {
  application: string;
  environment: string;
  expected_release_id: string;
  expected_version_id: string;
  expected_workspace_id?: string;
  contract: AcceptanceContract;
}

const DEFAULT_CONTRACT: AcceptanceContract = {
  schema_version: 1,
  routes: [
    {
      id: "root",
      path: "/",
      expected_status: [200],
      required: true,
    },
  ],
};

export function loadAcceptanceContract(
  appDir: string,
  explicitPath?: string,
): AcceptanceContract {
  const candidates = explicitPath
    ? [path.resolve(appDir, explicitPath)]
    : [
        path.join(appDir, ".miosa", "acceptance.json"),
        path.join(appDir, "miosa.app.json"),
      ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return DEFAULT_CONTRACT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(found, "utf8"));
  } catch (error) {
    throw new UserError(
      `Invalid acceptance contract ${found}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const outer = parsed as { acceptance?: unknown };
  const contract = (outer.acceptance ?? parsed) as Partial<AcceptanceContract>;
  if (
    contract.schema_version !== 1 ||
    !Array.isArray(contract.routes) ||
    contract.routes.length === 0
  ) {
    throw new UserError(
      `Acceptance contract ${found} must use schema_version 1 and declare at least one route.`,
    );
  }
  for (const route of contract.routes) {
    if (
      !route ||
      typeof route.id !== "string" ||
      typeof route.path !== "string" ||
      !Array.isArray(route.expected_status) ||
      route.expected_status.length === 0
    ) {
      throw new UserError(`Acceptance contract ${found} has an invalid route.`);
    }
  }
  return contract as AcceptanceContract;
}

export function saveReleaseReceipt(appDir: string, receipt: ReleaseReceipt): string {
  const receiptDir = path.join(appDir, ".miosa", "receipts");
  fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(receiptDir, `${receipt.receipt_id}.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  return receiptPath;
}

function check(
  checks: VerificationCheck[],
  id: string,
  ok: boolean,
  pass: string,
  fail: string,
  details?: Record<string, unknown>,
  recovery?: string[],
): void {
  checks.push({
    id,
    status: ok ? "pass" : "fail",
    message: ok ? pass : fail,
    ...(details ? { details } : {}),
    ...(!ok && recovery ? { recovery } : {}),
  });
}

function receiptId(input: VerifyApplicationReleaseInput, inspection: ReleaseInspection): string {
  return `rcpt_${createHash("sha256")
    .update(
      [
        input.application,
        input.environment,
        input.expected_release_id,
        input.expected_version_id,
        inspection.deployment_id,
        inspection.running_artifact_sha256 ?? "",
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

export async function verifyApplicationRelease(
  input: VerifyApplicationReleaseInput,
  adapter: ReleaseVerificationAdapter,
): Promise<ReleaseReceipt> {
  const inspection = await adapter.inspect();
  const checks: VerificationCheck[] = [];

  check(
    checks,
    "deployment_running",
    inspection.deployment_state === "running",
    "Deployment is running.",
    `Deployment state is ${inspection.deployment_state}, expected running.`,
  );
  if (input.expected_workspace_id) {
    check(
      checks,
      "workspace_scope",
      inspection.workspace_id === input.expected_workspace_id,
      "The deployment is attached to the intended workspace.",
      "The deployment workspace does not match the linked application.",
      {
        expected_workspace_id: input.expected_workspace_id,
        actual_workspace_id: inspection.workspace_id,
      },
    );
  }
  check(
    checks,
    "exact_release",
    inspection.active_release_id === input.expected_release_id &&
      inspection.active_version_id === input.expected_version_id,
    "The exact requested immutable release is active.",
    "The active release or version does not match the requested release.",
    {
      expected_release_id: input.expected_release_id,
      active_release_id: inspection.active_release_id,
      expected_version_id: input.expected_version_id,
      active_version_id: inspection.active_version_id,
    },
  );

  const digestComparable = Boolean(
    inspection.expected_artifact_sha256 && inspection.running_artifact_sha256,
  );
  check(
    checks,
    "artifact_integrity",
    digestComparable &&
      inspection.expected_artifact_sha256 === inspection.running_artifact_sha256,
    "The running artifact digest matches the immutable release.",
    digestComparable
      ? "The running artifact digest does not match the immutable release."
      : "Artifact identity is incomplete and cannot be proven.",
    {
      expected: inspection.expected_artifact_sha256,
      running: inspection.running_artifact_sha256,
    },
  );

  if (inspection.deployment_product === "docker_deploy") {
    check(
      checks,
      "placement",
      Boolean(
        inspection.host_id &&
          inspection.host_status === "active" &&
          inspection.appliance_status === "healthy",
      ),
      "App Engine placement is active and healthy.",
      "App Engine placement is missing, inactive, or unhealthy.",
      {
        host_id: inspection.host_id,
        host_status: inspection.host_status,
        appliance_status: inspection.appliance_status,
      },
    );
  }

  const requiredEnv = input.contract.required_env ?? [];
  const missingEnv = requiredEnv.filter(
    (name) => !inspection.effective_env_names.includes(name),
  );
  check(
    checks,
    "required_configuration",
    missingEnv.length === 0,
    `All ${requiredEnv.length} required configuration names are present.`,
    `Missing required configuration: ${missingEnv.join(", ")}.`,
    { required: requiredEnv, missing: missingEnv },
    missingEnv.map((name) => `miosa secrets set ${name} --app ${input.application}`),
  );

  if (input.contract.database?.required) {
    check(
      checks,
      "database_attachment",
      inspection.database_attached,
      "A durable database is attached.",
      "The application does not have a durable database attachment.",
    );
  }

  for (const connector of input.contract.connectors ?? []) {
    const healthy = inspection.healthy_connector_ids.includes(connector.id);
    checks.push({
      id: `connector:${connector.id}`,
      status: healthy ? "pass" : connector.required === false ? "warning" : "fail",
      message: healthy
        ? `Connector ${connector.id} is bound and healthy.`
        : `Connector ${connector.id} is not bound and healthy.`,
    });
  }

  for (const job of input.contract.scheduled_jobs ?? []) {
    const healthy = inspection.healthy_scheduled_job_ids.includes(job.id);
    checks.push({
      id: `scheduled_job:${job.id}`,
      status: healthy ? "pass" : job.required === false ? "warning" : "fail",
      message: healthy
        ? `Scheduled job ${job.id} is registered and healthy.`
        : `Scheduled job ${job.id} is not registered and healthy.`,
    });
  }

  if (!inspection.public_url) {
    check(
      checks,
      "public_url",
      false,
      "",
      "The deployment has no public URL.",
    );
  } else {
    for (const requirement of input.contract.routes) {
      const required = requirement.required !== false;
      try {
        const response = await adapter.probe(inspection.public_url, requirement.path);
        const statusOk = requirement.expected_status.includes(response.status);
        const bodyMissing = (requirement.body_contains ?? []).filter(
          (marker) => !response.body.includes(marker),
        );
        const typeOk =
          !requirement.content_type ||
          response.content_type?.toLowerCase().includes(
            requirement.content_type.toLowerCase(),
          );
        const ok = statusOk && bodyMissing.length === 0 && Boolean(typeOk);
        checks.push({
          id: `route:${requirement.id}`,
          status: ok ? "pass" : required ? "fail" : "warning",
          message: ok
            ? `${requirement.path} satisfied its declared contract.`
            : `${requirement.path} did not satisfy its declared contract.`,
          details: {
            status: response.status,
            expected_status: requirement.expected_status,
            missing_body_markers: bodyMissing,
            content_type: response.content_type,
            expected_content_type: requirement.content_type ?? null,
            latency_ms: response.latency_ms ?? null,
          },
        });
      } catch (error) {
        checks.push({
          id: `route:${requirement.id}`,
          status: required ? "fail" : "warning",
          message: `${requirement.path} probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const healthPath = input.contract.database?.health_path;
    if (input.contract.database?.required && healthPath) {
      try {
        const response = await adapter.probe(inspection.public_url, healthPath);
        const bodyHealthy =
          response.body.includes('"status":"ok"') &&
          response.body.includes('"database":"ok"');
        check(
          checks,
          "database_health",
          response.status === 200 && bodyHealthy,
          "Database health and application schema checks passed.",
          "Database health or application schema checks failed.",
          { status: response.status, path: healthPath },
        );
      } catch (error) {
        check(
          checks,
          "database_health",
          false,
          "",
          `Database health probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const blocked = checks.some((item) => item.status === "fail");
  const nextActions = checks
    .flatMap((item) => item.recovery ?? [])
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    schema_version: 1,
    receipt_id: receiptId(input, inspection),
    application: input.application,
    environment: input.environment,
    result: blocked ? "blocked" : "verified",
    promotion_allowed: !blocked,
    deployment: {
      id: inspection.deployment_id,
      name: inspection.deployment_name,
      product: inspection.deployment_product,
      url: inspection.public_url,
      host_id: inspection.host_id,
      tenant_id: inspection.tenant_id,
      workspace_id: inspection.workspace_id,
    },
    release: {
      id: input.expected_release_id,
      version_id: input.expected_version_id,
      artifact_sha256: inspection.expected_artifact_sha256,
    },
    checks,
    next_actions: nextActions,
    verified_at: new Date().toISOString(),
  };
}
