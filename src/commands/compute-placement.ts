import type { Command } from "commander";
import { UserError } from "../errors.js";
import type { ApiObject } from "./enterprise-util.js";

// Mirrors Engine.ComputePlacement.Request on the server (source of truth).
// The CLI only checks shape (required fields present, UUIDs look like UUIDs)
// so failures are fast and legible; every business rule (which provider needs
// which fields, fallback semantics, opencomputers being unimplemented) is
// enforced server-side and surfaced verbatim from its error response.
const PROVIDERS = ["miosa", "aws", "gcp", "opencomputers"] as const;
const FALLBACKS = ["deny", "miosa"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlacementOptions {
  provider?: string;
  regionId?: string;
  poolId?: string;
  hostId?: string;
  fallback?: string;
}

export function addPlacementOptions(command: Command): Command {
  return command
    .option(
      "--provider <provider>",
      "Compute origin: miosa, aws, gcp, or opencomputers (default: miosa)",
    )
    .option(
      "--region-id <uuid>",
      "Cloud region ID to target. Required (with --pool-id) for aws/gcp",
    )
    .option(
      "--pool-id <uuid>",
      "Cloud pool ID to target. Required (with --region-id) for aws/gcp",
    )
    .option(
      "--host-id <uuid>",
      "OpenComputers host ID to target. Required for opencomputers",
    )
    .option(
      "--fallback <mode>",
      "On unavailable capacity: deny, or miosa to fall back to the shared fleet (default: deny)",
    );
}

function assertUuid(value: string, flag: string): void {
  if (!UUID_RE.test(value)) {
    throw new UserError(`${flag} must be a UUID, got "${value}"`);
  }
}

/**
 * Builds the `compute_placement_request` map from CLI flags, or `undefined`
 * if the caller didn't ask for explicit placement (default server behavior
 * applies). Validates shape only — UUID-ness of IDs and that a provider was
 * given once any placement flag is used. All provider/target compatibility
 * rules (e.g. aws/gcp requiring region+pool, opencomputers requiring host,
 * opencomputers being unimplemented) are the server's to enforce; do not
 * duplicate them here.
 */
export function buildPlacementRequest(
  opts: PlacementOptions,
): ApiObject | undefined {
  const anyFlagSet =
    opts.provider !== undefined ||
    opts.regionId !== undefined ||
    opts.poolId !== undefined ||
    opts.hostId !== undefined ||
    opts.fallback !== undefined;
  if (!anyFlagSet) return undefined;

  if (!opts.provider) {
    throw new UserError(
      "--provider is required when using --region-id, --pool-id, --host-id, or --fallback",
    );
  }
  if (!PROVIDERS.includes(opts.provider as (typeof PROVIDERS)[number])) {
    throw new UserError(`--provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  if (
    opts.fallback !== undefined &&
    !FALLBACKS.includes(opts.fallback as (typeof FALLBACKS)[number])
  ) {
    throw new UserError(`--fallback must be one of: ${FALLBACKS.join(", ")}`);
  }
  if (opts.regionId !== undefined) assertUuid(opts.regionId, "--region-id");
  if (opts.poolId !== undefined) assertUuid(opts.poolId, "--pool-id");
  if (opts.hostId !== undefined) assertUuid(opts.hostId, "--host-id");

  const request: ApiObject = { provider: opts.provider };
  if (opts.regionId !== undefined) request["region_id"] = opts.regionId;
  if (opts.poolId !== undefined) request["pool_id"] = opts.poolId;
  if (opts.hostId !== undefined) request["host_id"] = opts.hostId;
  if (opts.fallback !== undefined) request["fallback"] = opts.fallback;
  return request;
}
