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
      migration_verified: true,
      policy_verified: true,
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

  it("verifies Next.js, static routes, database migrations, OAuth connectors, jobs, policy, and business capabilities", async () => {
    const fullContract: AcceptanceContract = {
      schema_version: 1,
      routes: [
        {
          id: "next-shell",
          path: "/",
          expected_status: [200],
          body_contains: ["__next"],
          required: true,
        },
        {
          id: "static-asset",
          path: "/logo.svg",
          expected_status: [200],
          content_type: "image/svg+xml",
          required: true,
        },
      ],
      required_env: ["DATABASE_URL", "OAUTH_CLIENT_SECRET"],
      database: { required: true, health_path: "/api/health" },
      migration: { required: true },
      policy: { required: true },
      connectors: [{ id: "oauth", required: true }],
      scheduled_jobs: [{ id: "daily-sync", required: true }],
      business_capabilities: [
        {
          id: "customer-cloud-sync",
          path: "/api/capabilities/customer-cloud",
          expected_status: [200],
          body_contains: ["ready"],
          required: true,
        },
      ],
    };
    const receipt = await verifyApplicationRelease(
      {
        application: "full-stack",
        environment: "production",
        expected_release_id: "rel_123",
        expected_version_id: "ver_123",
        expected_workspace_id: "ws_123",
        expected_organization_id: "tenant_123",
        rollback_version_id: "ver_122",
        contract: fullContract,
      },
      adapter({
        inspect: async () => ({
          deployment_id: "dep_123",
          deployment_name: "Full stack",
          tenant_id: "tenant_123",
          workspace_id: "ws_123",
          deployment_state: "running",
          deployment_product: "customer_cloud",
          public_url: "https://full.example.com",
          active_version_id: "ver_123",
          active_release_id: "rel_123",
          running_artifact_sha256: "abc123",
          expected_artifact_sha256: "abc123",
          host_id: null,
          host_status: null,
          appliance_status: null,
          database_attached: true,
          effective_env_names: ["DATABASE_URL", "OAUTH_CLIENT_SECRET"],
          healthy_connector_ids: ["oauth"],
          healthy_scheduled_job_ids: ["daily-sync"],
          migration_verified: true,
          policy_verified: true,
        }),
        probe: async (_url, routePath) => {
          if (routePath === "/api/health") {
            return {
              status: 200,
              body: '{"status":"ok","database":"ok"}',
              content_type: "application/json",
            };
          }
          if (routePath === "/logo.svg") {
            return {
              status: 200,
              body: "<svg />",
              content_type: "image/svg+xml",
            };
          }
          if (routePath === "/api/capabilities/customer-cloud") {
            return {
              status: 200,
              body: '{"status":"ready"}',
              content_type: "application/json",
            };
          }
          return {
            status: 200,
            body: '<div id="__next"></div>',
            content_type: "text/html",
          };
        },
      }),
    );

    expect(receipt.result).toBe("verified");
    expect(receipt.bindings.connector_ids).toEqual(["oauth"]);
    expect(receipt.bindings.scheduled_job_ids).toEqual(["daily-sync"]);
    expect(receipt.rollback.version_id).toBe("ver_122");
    expect(receipt.evidence.map((item) => item.check_id)).toEqual(
      expect.arrayContaining([
        "database_migration",
        "policy",
        "connector:oauth",
        "scheduled_job:daily-sync",
        "route:next-shell",
        "route:static-asset",
        "route:customer-cloud-sync",
      ]),
    );
  });
});
