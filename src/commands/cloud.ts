import type { Command } from "commander";
import {
  apiPath,
  client,
  enc,
  printValue,
  runAction,
  unwrap,
  type ApiObject,
  type JsonOptions,
} from "./enterprise-util.js";

type CloudOptions = JsonOptions & Record<string, string | boolean | undefined>;

function parseJsonObject(value: unknown, option: string): ApiObject | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${option} must be a valid JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${option} must be a valid JSON object`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${option} must be a valid JSON object`);
  }
  return parsed as ApiObject;
}

function parseInteger(value: unknown, option: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be an integer`);
  return parsed;
}

function compact(body: ApiObject): ApiObject {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function query(params: Record<string, string | number | undefined>): string {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) values.set(key, String(value));
  }
  const encoded = values.toString();
  return encoded ? `?${encoded}` : "";
}

async function get(path: string, opts: JsonOptions): Promise<void> {
  const value = unwrap(await client().apiGet<unknown>(apiPath(path)));
  printValue(value, opts);
}

async function post(path: string, body: ApiObject, opts: JsonOptions): Promise<void> {
  const value = unwrap(await client().apiPost<unknown>(apiPath(path), body));
  printValue(value, opts);
}

export function register(program: Command): void {
  const cloud = program
    .command("cloud")
    .description("Manage cloud accounts and AWS BYOC host pools");

  const accounts = cloud.command("accounts").description("Manage BYOC cloud accounts");
  accounts
    .command("list")
    .description("List cloud accounts")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) => runAction(() => get("/cloud/accounts", opts)));
  accounts
    .command("create")
    .description("Create an AWS BYOC account trust boundary")
    .requiredOption("--name <name>", "Account display name")
    .option("--external-account-id <id>", "Customer AWS account ID")
    .option("--default-region <region>", "Default AWS region")
    .option("--metadata <json>", "Metadata JSON object")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        post(
          "/cloud/accounts",
          compact({
            provider: "aws",
            mode: "customer_byoc",
            display_name: opts.name,
            external_account_id: opts.externalAccountId,
            credential_type: "assume_role",
            default_region: opts.defaultRegion,
            metadata: parseJsonObject(opts.metadata, "--metadata"),
          }),
          opts,
        ),
      ),
    );
  accounts
    .command("attach-role <account-id>")
    .description("Attach the customer-created AWS assume-role ARN")
    .requiredOption("--role-arn <arn>", "AWS IAM role ARN")
    .option("--default-region <region>", "Default AWS region")
    .option("--json", "Output as JSON")
    .action((accountId: string, opts: CloudOptions) =>
      runAction(() =>
        post(
          `/cloud/accounts/${enc(accountId)}/aws-role`,
          compact({ role_arn: opts.roleArn, default_region: opts.defaultRegion }),
          opts,
        ),
      ),
    );

  const regions = cloud.command("regions").description("Manage BYOC provider regions");
  regions
    .command("list")
    .description("List BYOC provider regions")
    .option("--account-id <id>", "Filter by cloud account ID")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        get(`/cloud/regions${query({ cloud_account_id: opts.accountId as string })}`, opts),
      ),
    );
  regions
    .command("create")
    .description("Create an AWS region configuration for a BYOC account")
    .requiredOption("--account-id <id>", "Cloud account ID")
    .requiredOption("--provider-region <region>", "AWS region, for example us-east-1")
    .requiredOption("--name <name>", "Region display name")
    .option("--provider-zone <zone>", "AWS availability zone")
    .option("--guest-supernet <cidr>", "Guest VM supernet")
    .option("--artifact-manifest-uri <uri>", "BYOC artifact manifest URI")
    .option("--network-ref <id>", "VPC or provider network ID")
    .option("--subnet-ref <id>", "Provider subnet ID")
    .option("--security-group-refs <ids>", "Comma-separated security group IDs")
    .option("--instance-profile-ref <name>", "AWS instance profile name or ARN")
    .option("--metadata <json>", "Metadata JSON object, including host_image_id when needed")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        post(
          "/cloud/regions",
          compact({
            cloud_account_id: opts.accountId,
            provider_region: opts.providerRegion,
            provider_zone: opts.providerZone,
            display_name: opts.name,
            guest_supernet: opts.guestSupernet,
            artifact_manifest_uri: opts.artifactManifestUri,
            network_ref: opts.networkRef,
            subnet_ref: opts.subnetRef,
            security_group_refs:
              typeof opts.securityGroupRefs === "string"
                ? opts.securityGroupRefs.split(",").map((value) => value.trim()).filter(Boolean)
                : undefined,
            instance_profile_ref: opts.instanceProfileRef,
            metadata: parseJsonObject(opts.metadata, "--metadata"),
          }),
          opts,
        ),
      ),
    );

  const pools = cloud.command("pools").description("Manage BYOC capacity pools");
  pools
    .command("list")
    .description("List BYOC capacity pools")
    .option("--region-id <id>", "Filter by cloud region ID")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        get(`/cloud/pools${query({ cloud_region_id: opts.regionId as string })}`, opts),
      ),
    );
  pools
    .command("create")
    .description("Create a BYOC capacity pool")
    .requiredOption("--region-id <id>", "Cloud region ID")
    .option("--instance-type <type>", "AWS instance type", "m7i.4xlarge")
    .option("--pool-kind <kind>", "cloudburst or standing_byoc", "standing_byoc")
    .option("--node-type <type>", "cloud_burst or byoc", "byoc")
    .option("--target-nodes <count>", "Initial desired nodes", "0")
    .option("--max-nodes <count>", "Maximum nodes", "1")
    .option("--ttl-seconds <seconds>", "Pool lifetime in seconds")
    .option("--max-hourly-cents <cents>", "Hourly cost guardrail in cents")
    .option("--placement-scope <scope>", "sandbox, computer, deployment, or mixed", "mixed")
    .option("--metadata <json>", "Metadata JSON object")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        post(
          "/cloud/pools",
          compact({
            cloud_region_id: opts.regionId,
            pool_kind: opts.poolKind,
            node_type: opts.nodeType,
            instance_type: opts.instanceType,
            target_nodes: parseInteger(opts.targetNodes, "--target-nodes"),
            max_nodes: parseInteger(opts.maxNodes, "--max-nodes"),
            ttl_seconds: parseInteger(opts.ttlSeconds, "--ttl-seconds"),
            max_hourly_cents: parseInteger(
              opts.maxHourlyCents,
              "--max-hourly-cents",
            ),
            placement_scope: opts.placementScope,
            metadata: parseJsonObject(opts.metadata, "--metadata"),
          }),
          opts,
        ),
      ),
    );
  pools
    .command("provision <pool-id>")
    .description("Provision hosts into a BYOC pool")
    .option("--count <count>", "Hosts to provision, from 1 to 50", "1")
    .option("--json", "Output as JSON")
    .action((poolId: string, opts: CloudOptions) =>
      runAction(() =>
        post(
          `/cloud/pools/${enc(poolId)}/provision`,
          { count: parseInteger(opts.count, "--count") },
          opts,
        ),
      ),
    );

  cloud
    .command("nodes")
    .description("List BYOC cloud nodes")
    .option("--pool-id <id>", "Filter by cloud pool ID")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        get(`/cloud/nodes${query({ cloud_pool_id: opts.poolId as string })}`, opts),
      ),
    );

  const preflights = cloud.command("preflights").description("Run and inspect BYOC preflight");
  preflights
    .command("list")
    .description("List recorded preflight results")
    .option("--account-id <id>", "Filter by cloud account ID")
    .option("--region-id <id>", "Filter by cloud region ID")
    .option("--limit <count>", "Maximum results")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() =>
        get(
          `/cloud/preflights${query({
            cloud_account_id: opts.accountId as string,
            cloud_region_id: opts.regionId as string,
            limit: parseInteger(opts.limit, "--limit"),
          })}`,
          opts,
        ),
      ),
    );
  preflights
    .command("run")
    .description("Run server-owned AWS account or region preflight checks")
    .option("--account-id <id>", "Cloud account ID")
    .option("--region-id <id>", "Cloud region ID")
    .option("--json", "Output as JSON")
    .action((opts: CloudOptions) =>
      runAction(() => {
        if (Boolean(opts.accountId) === Boolean(opts.regionId)) {
          throw new Error("Provide exactly one of --account-id or --region-id");
        }
        return post(
          "/cloud/preflights",
          compact({
            cloud_account_id: opts.accountId,
            cloud_region_id: opts.regionId,
          }),
          opts,
        );
      }),
    );
}
