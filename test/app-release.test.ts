import { describe, expect, it } from "vitest";
import {
  verifyApplicationRelease,
  type AcceptanceContract,
  type ReleaseVerificationAdapter,
} from "../src/app-release.js";

const contract: AcceptanceContract = {
  schema_version: 1,
  routes: [
    {
      id: "homepage",
      path: "/",
      expected_status: [200],
      body_contains: ["Federal contracting information"],
      required: true,
    },
  ],
  required_env: ["DATABASE_URL"],
  database: { required: true, health_path: "/api/health" },
};

function adapter(
  overrides: Partial<ReleaseVerificationAdapter> = {},
): ReleaseVerificationAdapter {
  return {
    inspect: async () => ({
      deployment_id: "dep_123",
      deployment_name: "Panther",
      tenant_id: "tenant_123",
      workspace_id: "ws_123",
      deployment_state: "running",
      deployment_product: "docker_deploy",
      public_url: "https://gov.example.com",
      active_version_id: "ver_123",
      active_release_id: "rel_123",
      running_artifact_sha256: "abc123",
      expected_artifact_sha256: "abc123",
      host_id: "host_123",
      host_status: "active",
      appliance_status: "healthy",
      database_attached: true,
      effective_env_names: ["DATABASE_URL"],
      healthy_connector_ids: [],
      healthy_scheduled_job_ids: [],
    }),
    probe: async (_url, path) =>
      path === "/api/health"
        ? {
            status: 200,
            body: '{"status":"ok","checks":{"database":"ok"}}',
            content_type: "application/json",
          }
        : {
            status: 200,
            body: "Federal contracting information",
            content_type: "text/html",
          },
    ...overrides,
  };
}

describe("application release verification", () => {
  it("accepts the exact running release only when its declared capabilities pass", async () => {
    const receipt = await verifyApplicationRelease(
      {
        application: "panther",
        environment: "production",
        expected_release_id: "rel_123",
        expected_version_id: "ver_123",
        contract,
      },
      adapter(),
    );

    expect(receipt.result).toBe("verified");
    expect(receipt.promotion_allowed).toBe(true);
    expect(receipt.release.id).toBe("rel_123");
    expect(receipt.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("blocks a release when a declared route returns an unexpected 404", async () => {
    const receipt = await verifyApplicationRelease(
      {
        application: "panther",
        environment: "production",
        expected_release_id: "rel_123",
        expected_version_id: "ver_123",
        contract,
      },
      adapter({
        probe: async (_url, path) =>
          path === "/api/health"
            ? {
                status: 200,
                body: '{"status":"ok","checks":{"database":"ok"}}',
                content_type: "application/json",
              }
            : { status: 404, body: "Not found", content_type: "text/html" },
      }),
    );

    expect(receipt.result).toBe("blocked");
    expect(receipt.promotion_allowed).toBe(false);
    expect(receipt.checks.find((check) => check.id === "route:homepage")?.status).toBe(
      "fail",
    );
  });
});
