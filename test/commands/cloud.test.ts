import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
}));

const { register } = await import("../../src/commands/cloud.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa cloud", () => {
  beforeEach(() => {
    process.env["MIOSA_JSON"] = "1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("uses the canonical AWS role route", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/accounts/account_1/aws-role",
        method: "POST",
        body: JSON.stringify({
          role_arn: "arn:aws:iam::123456789012:role/MiosaByocRole",
          default_region: "us-east-1",
        }),
      })
      .reply(200, JSON.stringify({ data: { id: "account_1" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "accounts",
      "attach-role",
      "account_1",
      "--role-arn",
      "arn:aws:iam::123456789012:role/MiosaByocRole",
      "--default-region",
      "us-east-1",
    ]);
  });

  it("sends backend-supported region and pool configuration", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const api = mock.get("https://api.miosa.ai");
    api
      .intercept({
        path: "/api/v1/cloud/regions",
        method: "POST",
        body: JSON.stringify({
          cloud_account_id: "account_1",
          provider_region: "us-east-1",
          display_name: "N. Virginia",
          artifact_manifest_uri: "s3://miosa-artifacts/manifest.json",
          subnet_ref: "subnet-123",
          security_group_refs: ["sg-123", "sg-456"],
          instance_profile_ref: "MiosaByocHost",
          metadata: { host_image_id: "ami-123" },
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "region_1" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({
        path: "/api/v1/cloud/pools",
        method: "POST",
        body: JSON.stringify({
          cloud_region_id: "region_1",
          pool_kind: "standing_byoc",
          node_type: "byoc",
          instance_type: "m7i.4xlarge",
          target_nodes: 0,
          max_nodes: 4,
          max_hourly_cents: 250,
          placement_scope: "mixed",
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "pool_1" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "cloud",
      "regions",
      "create",
      "--account-id",
      "account_1",
      "--provider-region",
      "us-east-1",
      "--name",
      "N. Virginia",
      "--artifact-manifest-uri",
      "s3://miosa-artifacts/manifest.json",
      "--subnet-ref",
      "subnet-123",
      "--security-group-refs",
      "sg-123,sg-456",
      "--instance-profile-ref",
      "MiosaByocHost",
      "--metadata",
      '{"host_image_id":"ami-123"}',
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "cloud",
      "pools",
      "create",
      "--region-id",
      "region_1",
      "--max-nodes",
      "4",
      "--max-hourly-cents",
      "250",
    ]);
  });

  it("fetches capabilities scoped to a region and pool", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/capabilities?cloud_region_id=region_1&cloud_pool_id=pool_1",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { resolution: "exact" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "capabilities",
      "--region-id",
      "region_1",
      "--pool-id",
      "pool_1",
    ]);
  });

  it("attaches GCP workload identity with both service accounts", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/accounts/account_1/gcp-workload-identity",
        method: "POST",
        body: JSON.stringify({
          project_id: "acme-prod",
          actuator_service_account_email:
            "actuator@acme-prod.iam.gserviceaccount.com",
          worker_service_account_email:
            "worker@acme-prod.iam.gserviceaccount.com",
        }),
      })
      .reply(200, JSON.stringify({ data: { id: "account_1" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "accounts",
      "attach-gcp",
      "account_1",
      "--project-id",
      "acme-prod",
      "--actuator-service-account",
      "actuator@acme-prod.iam.gserviceaccount.com",
      "--worker-service-account",
      "worker@acme-prod.iam.gserviceaccount.com",
    ]);
  });

  it("PATCHes region and pool updates", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const api = mock.get("https://api.miosa.ai");
    api
      .intercept({
        path: "/api/v1/cloud/regions/region_1",
        method: "PATCH",
        body: JSON.stringify({ display_name: "N. Virginia v2" }),
      })
      .reply(200, JSON.stringify({ data: { id: "region_1" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({
        path: "/api/v1/cloud/pools/pool_1",
        method: "PATCH",
        body: JSON.stringify({ max_nodes: 8 }),
      })
      .reply(200, JSON.stringify({ data: { id: "pool_1" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "cloud",
      "regions",
      "update",
      "region_1",
      "--name",
      "N. Virginia v2",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "cloud",
      "pools",
      "update",
      "pool_1",
      "--max-nodes",
      "8",
    ]);
  });

  it("certifies a node with the given workload and idempotency key", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/nodes/node_1/certify",
        method: "POST",
        body: JSON.stringify({
          workload: "computer",
          idempotency_key: "retry-key-1",
        }),
      })
      .reply(202, JSON.stringify({ data: { id: "op_1" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "nodes",
      "certify",
      "node_1",
      "--workload",
      "computer",
      "--idempotency-key",
      "retry-key-1",
    ]);
  });

  it("rejects an unsupported certify workload", async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync([
        "node",
        "miosa",
        "cloud",
        "nodes",
        "certify",
        "node_1",
        "--workload",
        "vm",
      ]),
    ).rejects.toThrow();
  });
});
