import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  loadAppManifest,
  type AppCapabilitiesManifest,
  type AppPolicyManifest,
  type MiosaAppManifest,
} from "./app-manifest.js";
import { UserError } from "./errors.js";

export interface ApplicationScope {
  organization: string;
  workspace: string;
  application: string;
  environment: string;
  deployment_id: string;
}

export type CandidateReleaseState =
  | "planned"
  | "approved"
  | "applying"
  | "verified"
  | "blocked"
  | "failed";

export interface PlanApproval {
  actor: string;
  approved_at: string;
  plan_fingerprint: string;
}

export interface SavedApplicationPlan {
  schema_version: 1;
  plan_id: string;
  fingerprint: string;
  control_plane_plan_id?: string;
  scope: ApplicationScope;
  release: {
    id: string;
    version_id: string;
    artifact_sha256: string;
    rollback_version_id: string | null;
  };
  desired_state: {
    route: { public_url: string | null };
    archive: { artifact_sha256: string };
    host: { id: string | null; status: string; appliance_status: string };
    database: { attached: boolean };
    connectors: { ids: string[] };
    jobs: { ids: string[] };
    policy: { fingerprint: string };
  };
  capabilities: AppCapabilitiesManifest;
  policy: AppPolicyManifest;
  state: CandidateReleaseState;
  approvals: PlanApproval[];
  created_at: string;
  updated_at: string;
}

export interface DriftItem {
  path: string;
  expected: unknown;
  actual: unknown;
  severity: "blocking" | "warning";
  reconcile: string;
}

const DEFAULT_CAPABILITIES: AppCapabilitiesManifest = {
  routes: [
    {
      id: "root",
      path: "/",
      expected_status: [200],
      required: true,
    },
  ],
  secrets: [],
  connectors: [],
  jobs: [],
  business: [],
};

const DEFAULT_POLICY: AppPolicyManifest = {
  approvals_required: 1,
  allowed_environments: [],
  require_immutable_release: true,
  require_rollback_path: true,
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

export function contractFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

export function resolveApplicationContract(
  appDir: string,
  link: {
    deploymentId?: string;
    name?: string;
    environment?: string;
    workspaceId?: string;
    organizationId?: string;
  },
): {
  manifest: MiosaAppManifest;
  scope: ApplicationScope;
  capabilities: AppCapabilitiesManifest;
  policy: AppPolicyManifest;
} {
  const loaded = loadAppManifest(appDir);
  const manifest = loaded?.manifest ?? {};
  const conflicts = [
    conflict("organization", manifest.organization, link.organizationId),
    conflict("workspace", manifest.workspace, link.workspaceId),
    conflict("application", manifest.application, link.name),
    conflict("environment", manifest.environment, link.environment),
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    throw new UserError(
      `Application scope conflicts with the linked deployment: ${conflicts.join("; ")}.`,
      "Update miosa.app.yml or relink the directory. MIOSA will not guess mutation scope.",
    );
  }
  const organization = manifest.organization ?? link.organizationId;
  const workspace = manifest.workspace ?? link.workspaceId;
  const application = manifest.application ?? link.name;
  const environment = manifest.environment ?? link.environment;
  const deploymentId = link.deploymentId;
  const missing = [
    !organization ? "organization" : null,
    !workspace ? "workspace" : null,
    !application ? "application" : null,
    !environment ? "environment" : null,
    !deploymentId ? "deployment" : null,
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) {
    throw new UserError(
      `Application scope is ambiguous: missing ${missing.join(", ")}.`,
      "Declare organization, workspace, application, and environment in miosa.app.yml, then run `miosa app link`.",
    );
  }
  if (
    !organization ||
    !workspace ||
    !application ||
    !environment ||
    !deploymentId
  ) {
    throw new UserError("Application scope could not be resolved.");
  }
  return {
    manifest,
    scope: {
      organization,
      workspace,
      application,
      environment,
      deployment_id: deploymentId,
    },
    capabilities: manifest.capabilities ?? DEFAULT_CAPABILITIES,
    policy: { ...DEFAULT_POLICY, ...manifest.policy },
  };
}

function conflict(
  field: string,
  declared: string | undefined,
  linked: string | undefined,
): string | null {
  return declared && linked && declared !== linked
    ? `${field} declares ${declared} but link resolves ${linked}`
    : null;
}

function planDir(appDir: string): string {
  return path.join(appDir, ".miosa", "plans");
}

function planPayload(
  plan: Omit<SavedApplicationPlan, "fingerprint" | "approvals" | "state" | "created_at" | "updated_at">,
): unknown {
  return {
    schema_version: plan.schema_version,
    scope: plan.scope,
    release: plan.release,
    desired_state: plan.desired_state,
    capabilities: plan.capabilities,
    policy: plan.policy,
  };
}

export function createSavedPlan(
  appDir: string,
  input: {
    scope: ApplicationScope;
    release: SavedApplicationPlan["release"];
    desired_state: SavedApplicationPlan["desired_state"];
    capabilities: AppCapabilitiesManifest;
    policy: AppPolicyManifest;
  },
): SavedApplicationPlan {
  if (!input.release.version_id || !input.release.artifact_sha256) {
    throw new UserError(
      "A saved plan requires an immutable version ID and artifact digest.",
    );
  }
  if (
    input.policy.allowed_environments.length > 0 &&
    !input.policy.allowed_environments.includes(input.scope.environment)
  ) {
    throw new UserError(
      `Policy does not allow environment ${input.scope.environment}.`,
    );
  }
  if (input.policy.require_rollback_path && !input.release.rollback_version_id) {
    throw new UserError(
      "Policy requires an exact rollback version before this plan can be saved.",
    );
  }
  const now = new Date().toISOString();
  const base = {
    schema_version: 1 as const,
    plan_id: `plan_${randomUUID()}`,
    scope: input.scope,
    release: input.release,
    desired_state: input.desired_state,
    capabilities: input.capabilities,
    policy: input.policy,
  };
  const plan: SavedApplicationPlan = {
    ...base,
    fingerprint: contractFingerprint(planPayload(base)),
    state: "planned",
    approvals: [],
    created_at: now,
    updated_at: now,
  };
  savePlan(appDir, plan);
  return plan;
}

export function savePlan(appDir: string, plan: SavedApplicationPlan): string {
  const dir = planDir(appDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${plan.plan_id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function loadPlan(appDir: string, planId: string): SavedApplicationPlan {
  const file = path.join(planDir(appDir), `${planId}.json`);
  if (!fs.existsSync(file)) throw new UserError(`Saved plan not found: ${planId}`);
  const plan = JSON.parse(fs.readFileSync(file, "utf8")) as SavedApplicationPlan;
  assertPlanIntegrity(plan);
  return plan;
}

export function assertPlanIntegrity(plan: SavedApplicationPlan): void {
  const fingerprint = contractFingerprint(planPayload(plan));
  if (fingerprint !== plan.fingerprint) {
    throw new UserError(
      `Saved plan ${plan.plan_id} has changed since it was created.`,
      "Create and approve a new plan. Exact apply never accepts a modified plan.",
    );
  }
}

export function approvePlan(
  appDir: string,
  plan: SavedApplicationPlan,
  actor: string,
): SavedApplicationPlan {
  assertPlanIntegrity(plan);
  const approval: PlanApproval = {
    actor,
    approved_at: new Date().toISOString(),
    plan_fingerprint: plan.fingerprint,
  };
  const approvals = [
    ...plan.approvals.filter((item) => item.actor !== actor),
    approval,
  ];
  const next: SavedApplicationPlan = {
    ...plan,
    approvals,
    state:
      approvals.length >= plan.policy.approvals_required
        ? "approved"
        : "planned",
    updated_at: approval.approved_at,
  };
  savePlan(appDir, next);
  return next;
}

export function assertPlanApplicable(
  plan: SavedApplicationPlan,
  actualScope: ApplicationScope,
): void {
  assertPlanIntegrity(plan);
  if (contractFingerprint(plan.scope) !== contractFingerprint(actualScope)) {
    throw new UserError(
      `Saved plan ${plan.plan_id} does not match the active organization, workspace, application, environment, and deployment.`,
    );
  }
  if (plan.approvals.length < plan.policy.approvals_required) {
    throw new UserError(
      `Saved plan ${plan.plan_id} has ${plan.approvals.length} approvals, but policy requires ${plan.policy.approvals_required}.`,
    );
  }
  if (!plan.approvals.every((item) => item.plan_fingerprint === plan.fingerprint)) {
    throw new UserError(`Saved plan ${plan.plan_id} contains a stale approval.`);
  }
}

export function detectContractDrift(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  prefix = "",
): DriftItem[] {
  const items: DriftItem[] = [];
  for (const key of Object.keys(expected).sort()) {
    const pathName = prefix ? `${prefix}.${key}` : key;
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (
      expectedValue &&
      typeof expectedValue === "object" &&
      !Array.isArray(expectedValue) &&
      actualValue &&
      typeof actualValue === "object" &&
      !Array.isArray(actualValue)
    ) {
      items.push(
        ...detectContractDrift(
          expectedValue as Record<string, unknown>,
          actualValue as Record<string, unknown>,
          pathName,
        ),
      );
    } else if (
      contractFingerprint(expectedValue) !== contractFingerprint(actualValue)
    ) {
      items.push({
        path: pathName,
        expected: expectedValue,
        actual: actualValue,
        severity: "blocking",
        reconcile: `restore ${pathName} to the saved plan value`,
      });
    }
  }
  return items;
}
