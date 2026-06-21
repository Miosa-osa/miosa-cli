import { afterEach, describe, expect, it, vi } from "vitest";
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

function captureLogs(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  return logged;
}

describe("miosa cloud", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("creates an AWS BYOC account and attaches an assume-role ARN", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/accounts",
        method: "POST",
        body: JSON.stringify({
          provider: "aws",
          mode: "customer_byoc",
          display_name: "Customer AWS",
          external_account_id: "123456789012",
          credential_type: "assume_role",
          default_region: "us-east-1",
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "cloud_acct_123" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/accounts/cloud_acct_123/aws/role",
        method: "POST",
        body: JSON.stringify({
          role_arn: "arn:aws:iam::123456789012:role/MiosaByocRole",
          default_region: "us-east-1",
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "cloud_acct_123",
            role_arn: "arn:aws:iam::123456789012:role/MiosaByocRole",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "accounts",
      "create",
      "--provider",
      "aws",
      "--mode",
      "customer_byoc",
      "--display-name",
      "Customer AWS",
      "--external-account-id",
      "123456789012",
      "--credential-type",
      "assume_role",
      "--default-region",
      "us-east-1",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "accounts",
      "attach-aws-role",
      "cloud_acct_123",
      "--role-arn",
      "arn:aws:iam::123456789012:role/MiosaByocRole",
      "--default-region",
      "us-east-1",
      "--json",
    ]);

    const outputs = logged.map((line) => JSON.parse(line));
    expect(outputs[0]).toMatchObject({ id: "cloud_acct_123" });
    expect(outputs[1]).toMatchObject({
      role_arn: "arn:aws:iam::123456789012:role/MiosaByocRole",
    });
  });

  it("creates a cloud region, pool, and preflight record", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/regions",
        method: "POST",
        body: JSON.stringify({
          cloud_account_id: "cloud_acct_123",
          provider_region: "us-east-1",
          provider_zone: "us-east-1a",
          display_name: "N. Virginia",
          guest_supernet: "172.20.0.0/12",
          artifact_manifest_uri: "s3://miosa-artifacts/releases/current.json",
          network_ref: "vpc-123",
          subnet_ref: "subnet-123",
          security_group_refs: ["sg-123", "sg-456"],
          instance_profile_ref: "MiosaWorkerProfile",
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "cloud_region_123" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/pools",
        method: "POST",
        body: JSON.stringify({
          cloud_region_id: "cloud_region_123",
          pool_kind: "cloudburst",
          node_type: "cloud_burst",
          instance_type: "c6i.metal",
          target_nodes: 1,
          max_nodes: 4,
          ttl_seconds: 7200,
          max_hourly_cents: 2500,
          placement_scope: "sandbox",
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "cloud_pool_123" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/preflights",
        method: "POST",
        body: JSON.stringify({
          cloud_account_id: "cloud_acct_123",
          cloud_region_id: "cloud_region_123",
          provider: "aws",
          status: "pass",
          checks: { sts_identity: { status: "pass" } },
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "preflight_123" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "regions",
      "create",
      "--cloud-account-id",
      "cloud_acct_123",
      "--provider-region",
      "us-east-1",
      "--provider-zone",
      "us-east-1a",
      "--display-name",
      "N. Virginia",
      "--guest-supernet",
      "172.20.0.0/12",
      "--artifact-manifest-uri",
      "s3://miosa-artifacts/releases/current.json",
      "--network-ref",
      "vpc-123",
      "--subnet-ref",
      "subnet-123",
      "--security-group-refs",
      "sg-123,sg-456",
      "--instance-profile-ref",
      "MiosaWorkerProfile",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "pools",
      "create",
      "--cloud-region-id",
      "cloud_region_123",
      "--instance-type",
      "c6i.metal",
      "--target-nodes",
      "1",
      "--max-nodes",
      "4",
      "--ttl-seconds",
      "7200",
      "--max-hourly-cents",
      "2500",
      "--placement-scope",
      "sandbox",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "preflights",
      "record",
      "--cloud-account-id",
      "cloud_acct_123",
      "--cloud-region-id",
      "cloud_region_123",
      "--provider",
      "aws",
      "--status",
      "pass",
      "--checks",
      '{"sts_identity":{"status":"pass"}}',
      "--json",
    ]);

    const outputs = logged.map((line) => JSON.parse(line));
    expect(outputs[0]).toMatchObject({ id: "cloud_region_123" });
    expect(outputs[1]).toMatchObject({ id: "cloud_pool_123" });
    expect(outputs[2]).toMatchObject({ id: "preflight_123" });
  });

  it("lists preflights with cloud filters and prints the safe plan", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/cloud/preflights?cloud_account_id=cloud_acct_123&limit=5",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [{ id: "preflight_123" }] }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "cloud",
      "preflights",
      "list",
      "--cloud-account-id",
      "cloud_acct_123",
      "--limit",
      "5",
      "--json",
    ]);
    await buildProgram().parseAsync(["node", "miosa", "cloud", "plan", "--json"]);

    const outputs = logged.map((line) => JSON.parse(line));
    expect(outputs[0]).toMatchObject([{ id: "preflight_123" }]);
    expect(outputs[1]).toMatchObject({
      next_step: "aws_preflight",
      launches_resources: false,
    });
  });
});
