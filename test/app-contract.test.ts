import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvePlan,
  assertPlanApplicable,
  createSavedPlan,
  detectContractDrift,
  loadPlan,
  resolveApplicationContract,
} from "../src/app-contract.js";

function tempApp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miosa-contract-"));
}

describe("capability-gated application contract", () => {
  it("resolves one exact organization, workspace, application, environment, and deployment", () => {
    const dir = tempApp();
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic
organization: org_123
workspace: ws_123
application: clinic
environment: production
services:
  web:
    command: npm start
    port: 3000
capabilities:
  routes:
    - id: root
      path: /
      expected_status: [200]
  secrets:
    - SESSION_SECRET
policy:
  approvals_required: 1
  allowed_environments: [production]
`,
    );

    const contract = resolveApplicationContract(dir, {
      deploymentId: "dep_123",
      name: "clinic",
      environment: "production",
      workspaceId: "ws_123",
    });

    expect(contract.scope).toEqual({
      organization: "org_123",
      workspace: "ws_123",
      application: "clinic",
      environment: "production",
      deployment_id: "dep_123",
    });
    expect(contract.capabilities.secrets).toEqual([
      { name: "SESSION_SECRET", required: true },
    ]);
  });

  it("refuses ambiguous mutation scope", () => {
    const dir = tempApp();
    expect(() =>
      resolveApplicationContract(dir, {
        deploymentId: "dep_123",
        name: "clinic",
        environment: "production",
      }),
    ).toThrow(/missing organization, workspace/);
  });

  it("saves an immutable plan, records approval, and validates exact apply", () => {
    const dir = tempApp();
    const scope = {
      organization: "org_123",
      workspace: "ws_123",
      application: "clinic",
      environment: "production",
      deployment_id: "dep_123",
    };
    const input = {
      scope,
      release: {
        id: "rel_123",
        version_id: "ver_123",
        artifact_sha256: "sha256:abc",
        rollback_version_id: "ver_122",
      },
      desired_state: {
        route: { public_url: "https://clinic.example.com" },
        archive: { artifact_sha256: "sha256:abc" },
        host: {
          id: "host_123",
          status: "active",
          appliance_status: "healthy",
        },
        database: { attached: false },
        connectors: { ids: [] },
        jobs: { ids: [] },
        policy: { fingerprint: "policy_123" },
      },
      capabilities: {
        routes: [
          { id: "root", path: "/", expected_status: [200], required: true },
        ],
        secrets: [],
        connectors: [],
        jobs: [],
        business: [],
      },
      policy: {
        approvals_required: 1,
        allowed_environments: ["production"],
        require_immutable_release: true,
        require_rollback_path: true,
      },
    };
    const plan = createSavedPlan(dir, input);
    const retriedPlan = createSavedPlan(dir, input);
    const approved = approvePlan(dir, plan, "roberto@example.com");

    expect(retriedPlan.plan_id).not.toBe(plan.plan_id);
    expect(retriedPlan.fingerprint).toBe(plan.fingerprint);
    expect(approved.state).toBe("approved");
    expect(() => assertPlanApplicable(loadPlan(dir, plan.plan_id), scope)).not.toThrow();

    const file = path.join(dir, ".miosa", "plans", `${plan.plan_id}.json`);
    const edited = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    (edited["release"] as Record<string, unknown>)["id"] = "rel_attacker";
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(() => loadPlan(dir, plan.plan_id)).toThrow(/changed since it was created/);
  });

  it("detects release, route, binding, and policy drift as explicit paths", () => {
    const drift = detectContractDrift(
      {
        release: { id: "rel_new", digest: "abc" },
        route: { domain: "app.example.com" },
        database: { id: "db_1" },
        policy: { approvals: 2 },
      },
      {
        release: { id: "rel_old", digest: "def" },
        route: { domain: "old.example.com" },
        database: { id: "db_2" },
        policy: { approvals: 0 },
      },
    );

    expect(drift.map((item) => item.path)).toEqual([
      "database.id",
      "policy.approvals",
      "release.digest",
      "release.id",
      "route.domain",
    ]);
  });
});
