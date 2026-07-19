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
});
