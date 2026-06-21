import type { Command } from "commander";
import chalk from "chalk";
import {
  apiPath,
  client,
  enc,
  printValue,
  runAction,
  type JsonOptions,
} from "./enterprise-util.js";

type CloudCommandOptions = JsonOptions;

type AccountCreateOptions = CloudCommandOptions & {
  provider: string;
  mode: string;
  displayName?: string;
  externalAccountId?: string;
  credentialType?: string;
  defaultRegion?: string;
};

type AwsRoleOptions = CloudCommandOptions & {
  roleArn: string;
  defaultRegion?: string;
};

type RegionListOptions = CloudCommandOptions & {
  cloudAccountId?: string;
};

type RegionCreateOptions = CloudCommandOptions & {
  cloudAccountId: string;
  providerRegion: string;
  providerZone?: string;
  displayName?: string;
  guestSupernet?: string;
  artifactManifestUri?: string;
  networkRef?: string;
  subnetRef?: string;
  securityGroupRefs?: string;
  instanceProfileRef?: string;
};

type PoolListOptions = CloudCommandOptions & {
  cloudRegionId?: string;
};

type PoolCreateOptions = CloudCommandOptions & {
  cloudRegionId: string;
  poolKind?: string;
  nodeType?: string;
  instanceType: string;
  targetNodes?: string;
  maxNodes?: string;
  ttlSeconds?: string;
  maxHourlyCents?: string;
  placementScope?: string;
};

type PreflightListOptions = CloudCommandOptions & {
  cloudAccountId?: string;
  cloudRegionId?: string;
  limit?: string;
};

type PreflightRecordOptions = CloudCommandOptions & {
  cloudAccountId?: string;
  cloudRegionId?: string;
  provider: string;
  status: string;
  checks?: string;
  rawReport?: string;
};

export function register(program: Command): void {
  const cloud = program
    .command("cloud")
    .description("Manage MIOSA cloud accounts, BYOC regions, pools, and preflights");

  const accounts = cloud
    .command("accounts")
    .alias("account")
    .description("Manage connected cloud accounts");

  accounts
    .command("list")
    .description("List cloud accounts")
    .option("--json", "Output as JSON")
    .action((opts: CloudCommandOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(apiPath("/cloud/accounts"));
        printValue(unwrap(raw), opts);
      }),
    );

  accounts
    .command("create")
    .description("Create a MIOSA-managed or customer BYOC cloud account")
    .requiredOption("--provider <provider>", "Cloud provider: aws or gcp")
    .requiredOption("--mode <mode>", "Account mode: miosa_managed or customer_byoc")
    .option("--display-name <name>", "Human-readable account name")
    .option("--external-account-id <id>", "AWS account ID or GCP project ID")
    .option("--credential-type <type>", "Credential type, e.g. assume_role")
    .option("--default-region <region>", "Default provider region")
    .option("--json", "Output as JSON")
    .action((opts: AccountCreateOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          apiPath("/cloud/accounts"),
          compact({
            provider: opts.provider,
            mode: opts.mode,
            display_name: opts.displayName,
            external_account_id: opts.externalAccountId,
            credential_type: opts.credentialType,
            default_region: opts.defaultRegion,
          }),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  accounts
    .command("attach-aws-role <account-id>")
    .description("Attach a customer AWS assume-role ARN to a BYOC account")
    .requiredOption("--role-arn <arn>", "AWS IAM role ARN")
    .option("--default-region <region>", "Default AWS region")
    .option("--json", "Output as JSON")
    .action((accountId: string, opts: AwsRoleOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          apiPath(`/cloud/accounts/${enc(accountId)}/aws/role`),
          compact({
            role_arn: opts.roleArn,
            default_region: opts.defaultRegion,
          }),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  const regions = cloud
    .command("regions")
    .alias("region")
    .description("Manage cloud provider regions");

  regions
    .command("list")
    .description("List cloud regions")
    .option("--cloud-account-id <id>", "Filter by cloud account")
    .option("--json", "Output as JSON")
    .action((opts: RegionListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          apiPath(`/cloud/regions${query({ cloud_account_id: opts.cloudAccountId })}`),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  regions
    .command("create")
    .description("Create a cloud region record")
    .requiredOption("--cloud-account-id <id>", "Cloud account ID")
    .requiredOption("--provider-region <region>", "Provider region, e.g. us-east-1")
    .option("--provider-zone <zone>", "Provider availability zone")
    .option("--display-name <name>", "Human-readable region name")
    .option("--guest-supernet <cidr>", "Guest IP supernet CIDR")
    .option("--artifact-manifest-uri <uri>", "Artifact manifest URI")
    .option("--network-ref <ref>", "Provider VPC/network reference")
    .option("--subnet-ref <ref>", "Provider subnet reference")
    .option("--security-group-refs <refs>", "Comma-separated security group refs")
    .option("--instance-profile-ref <ref>", "Instance profile reference")
    .option("--json", "Output as JSON")
    .action((opts: RegionCreateOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          apiPath("/cloud/regions"),
          compact({
            cloud_account_id: opts.cloudAccountId,
            provider_region: opts.providerRegion,
            provider_zone: opts.providerZone,
            display_name: opts.displayName,
            guest_supernet: opts.guestSupernet,
            artifact_manifest_uri: opts.artifactManifestUri,
            network_ref: opts.networkRef,
            subnet_ref: opts.subnetRef,
            security_group_refs: csv(opts.securityGroupRefs),
            instance_profile_ref: opts.instanceProfileRef,
          }),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  const pools = cloud
    .command("pools")
    .alias("pool")
    .description("Manage cloud worker pools");

  pools
    .command("list")
    .description("List cloud worker pools")
    .option("--cloud-region-id <id>", "Filter by cloud region")
    .option("--json", "Output as JSON")
    .action((opts: PoolListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          apiPath(`/cloud/pools${query({ cloud_region_id: opts.cloudRegionId })}`),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  pools
    .command("create")
    .description("Create a cloud worker pool")
    .requiredOption("--cloud-region-id <id>", "Cloud region ID")
    .requiredOption("--instance-type <type>", "Provider instance type")
    .option("--pool-kind <kind>", "Pool kind", "cloudburst")
    .option("--node-type <type>", "Fleet node type", "cloud_burst")
    .option("--target-nodes <n>", "Desired node count")
    .option("--max-nodes <n>", "Maximum node count")
    .option("--ttl-seconds <seconds>", "Pool TTL")
    .option("--max-hourly-cents <cents>", "Hourly cost cap")
    .option("--placement-scope <scope>", "sandbox, computer, deployment, or mixed")
    .option("--json", "Output as JSON")
    .action((opts: PoolCreateOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          apiPath("/cloud/pools"),
          compact({
            cloud_region_id: opts.cloudRegionId,
            pool_kind: opts.poolKind,
            node_type: opts.nodeType,
            instance_type: opts.instanceType,
            target_nodes: intOpt(opts.targetNodes),
            max_nodes: intOpt(opts.maxNodes),
            ttl_seconds: intOpt(opts.ttlSeconds),
            max_hourly_cents: intOpt(opts.maxHourlyCents),
            placement_scope: opts.placementScope,
          }),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  const preflights = cloud
    .command("preflights")
    .alias("preflight")
    .description("Manage cloud credential and region preflight results");

  preflights
    .command("list")
    .description("List cloud preflight runs")
    .option("--cloud-account-id <id>", "Filter by cloud account")
    .option("--cloud-region-id <id>", "Filter by cloud region")
    .option("--limit <n>", "Maximum runs")
    .option("--json", "Output as JSON")
    .action((opts: PreflightListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          apiPath(
            `/cloud/preflights${query({
              cloud_account_id: opts.cloudAccountId,
              cloud_region_id: opts.cloudRegionId,
              limit: opts.limit,
            })}`,
          ),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  preflights
    .command("record")
    .description("Record a cloud preflight result")
    .option("--cloud-account-id <id>", "Cloud account ID")
    .option("--cloud-region-id <id>", "Cloud region ID")
    .requiredOption("--provider <provider>", "Cloud provider")
    .requiredOption("--status <status>", "pass, warn, or fail")
    .option("--checks <json>", "Checks JSON object")
    .option("--raw-report <json>", "Raw report JSON object")
    .option("--json", "Output as JSON")
    .action((opts: PreflightRecordOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          apiPath("/cloud/preflights"),
          compact({
            cloud_account_id: opts.cloudAccountId,
            cloud_region_id: opts.cloudRegionId,
            provider: opts.provider,
            status: opts.status,
            checks: jsonObjectOpt(opts.checks, "--checks"),
            raw_report: jsonObjectOpt(opts.rawReport, "--raw-report"),
          }),
        );
        printValue(unwrap(raw), opts);
      }),
    );

  cloud
    .command("plan")
    .description("Print the safe AWS/GCP BYOC test sequence")
    .option("--json", "Output as JSON")
    .action((opts: CloudCommandOptions) =>
      runAction(async () => {
        const value = {
          next_step: "aws_preflight",
          launches_resources: false,
          command:
            "AWS_REGION=us-east-1 go run ./cmd/aws-preflight --region us-east-1 --instance-type c6i.metal",
          sequence: [
            "merge/deploy HostAcceptanceRun API",
            "merge/deploy cloud account API",
            "publish artifact manifest",
            "run AWS read-only preflight",
            "launch one fenced .metal worker",
            "bootstrap and run HostAcceptanceRun",
            "boot one pinned sandbox",
            "drain, terminate, and leak-audit",
          ],
        };
        if (opts.json) {
          printValue(value, opts);
          return;
        }
        console.log(chalk.bold("Next safe step"));
        console.log(`  ${value.next_step}`);
        console.log();
        console.log(chalk.bold("Command"));
        console.log(`  ${value.command}`);
        console.log();
        console.log(chalk.bold("Sequence"));
        for (const [i, item] of value.sequence.entries()) {
          console.log(`  ${i + 1}. ${item}`);
        }
      }),
    );
}

function unwrap(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "data" in (payload as Record<string, unknown>)
  ) {
    return (payload as Record<string, unknown>)["data"];
  }
  return payload;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function query(input: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function intOpt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer: ${value}`);
  return parsed;
}

function jsonObjectOpt(
  value: string | undefined,
  flag: string,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
