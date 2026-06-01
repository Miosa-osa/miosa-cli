import type { Command } from "commander";
import {
  apiPath,
  client,
  printValue,
  runAction,
  unwrap,
  type JsonOptions,
} from "./enterprise-util.js";

type CleanupOptions = JsonOptions & {
  workspace?: string;
  state?: string;
  namePrefix?: string;
  tag?: string;
  olderThan?: string;
  limit?: string;
  dryRun?: boolean;
  force?: boolean;
};

const RESOURCE_TYPES = [
  "sandboxes",
  "deployments",
  "apps",
  "domains",
  "databases",
  "storage",
  "secrets",
  "functions",
  "cron",
  "snapshots",
  "checkpoints",
  "computers",
] as const;

export function register(program: Command): void {
  program
    .command("cleanup <resource-type>")
    .description("Bulk cleanup workspace resources with filters, dry-run, and force")
    .option("--workspace <id>", "Workspace ID to scope cleanup")
    .option("--state <state>", "Filter by resource state")
    .option("--name-prefix <prefix>", "Filter by resource name prefix")
    .option("--tag <tag>", "Filter sandboxes by tag key or key=value")
    .option("--older-than <duration>", "Filter by age, for example 2h or 30m")
    .option("--limit <n>", "Maximum resources per type")
    .option("--dry-run", "Return exact resources without deleting")
    .option("--force", "Actually delete matched resources")
    .option("--json", "Output as JSON")
    .action((resourceType: string, opts: CleanupOptions) =>
      runAction(async () => {
        const workspace = opts.workspace ?? process.env["MIOSA_WORKSPACE"];
        if (!workspace) {
          throw new Error("Cleanup requires --workspace <id> or MIOSA_WORKSPACE.");
        }
        validateResourceType(resourceType);

        const result = await client().apiPost<unknown>(
          apiPath(`/workspaces/${encodeURIComponent(workspace)}/cleanup`),
          cleanupBody(resourceType, opts),
        );
        printValue(unwrap(result), opts);
      }),
    );
}

function cleanupBody(
  resourceType: string,
  opts: CleanupOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    resource_type: resourceType,
  };
  if (opts.state) body["state"] = opts.state;
  if (opts.namePrefix) body["name_prefix"] = opts.namePrefix;
  if (opts.tag) body["tag"] = opts.tag;
  if (opts.olderThan) body["older_than"] = opts.olderThan;
  if (opts.limit) body["limit"] = Number.parseInt(opts.limit, 10);
  if (opts.dryRun) body["dry_run"] = true;
  if (opts.force) body["force"] = true;
  return body;
}

function validateResourceType(resourceType: string): void {
  const normalized = resourceType.toLowerCase();
  if (!(RESOURCE_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Unsupported resource type. Use: ${RESOURCE_TYPES.join(", ")}`);
  }
}
