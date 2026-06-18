import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { buildOsaProject } from "./build.js";
import type { OsaExecutionPlan, OsaRuntimeProfile } from "./types.js";

export interface OsaRunDispatchOptions {
  project?: string;
  task: string;
  sandbox?: string;
  computer?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  timeout?: string;
  dryRun?: boolean;
}

export interface OsaRunDispatchResult {
  plan: OsaExecutionPlan;
  request: Record<string, unknown>;
  run?: unknown;
}

export async function dispatchOsaRun(options: OsaRunDispatchOptions): Promise<OsaRunDispatchResult> {
  const { createOsaPlan } = await import("./plans.js");
  const plan = createOsaPlan({
    kind: "run",
    target: options.project,
    runtimeTarget: options.computer ? "computer" : options.sandbox ? "sandbox" : undefined,
    task: options.task,
  });
  const build = buildOsaProject({ target: options.project });
  const runtimeProfile = applyRunOverrides(plan.runtimeProfile, {
    provider: options.provider,
    model: options.model,
    runtimeTarget: options.computer ? "computer" : options.sandbox ? "sandbox" : undefined,
  });

  const target = resolveTarget(options, runtimeProfile);
  const request: Record<string, unknown> = {
    prompt: options.task,
    provider: resolvedProvider(runtimeProfile),
    runtime_profile: runtimeProfile,
    metadata: {
      osa_project: true,
      osa_manifest_path: build.manifestPath,
      osa_build_path: ".miosa/osa-build.json",
      osa_agent_name: plan.agentName,
      osa_runtime_target: plan.target,
    },
  };

  if (target.kind === "sandbox") request["sandbox_id"] = target.id;
  if (target.kind === "computer") request["computer_id"] = target.id;
  const model = resolvedModel(runtimeProfile);
  if (model) request["model"] = model;
  if (options.cwd) request["cwd"] = options.cwd;
  if (options.timeout) request["timeout"] = options.timeout;

  if (options.dryRun) return { plan: { ...plan, runtimeProfile }, request };

  const client = new MiosaClient(loadConfig());
  const run = await client.apiPost<unknown>("/api/v1/agent-runs", request);
  return { plan: { ...plan, runtimeProfile }, request, run };
}

function resolveTarget(
  options: OsaRunDispatchOptions,
  runtimeProfile: OsaRuntimeProfile,
): { kind: "sandbox" | "computer" | "managed"; id?: string } {
  if (options.sandbox && options.computer) {
    throw new UserError("Use either --sandbox or --computer, not both.");
  }
  if (options.sandbox) return { kind: "sandbox", id: options.sandbox };
  if (options.computer) return { kind: "computer", id: options.computer };
  const runtimeTarget = stringFromRecord(runtimeProfile.runtime, "target");
  if (runtimeTarget === "miosa-cloud" || runtimeTarget === "managed") {
    return { kind: "managed" };
  }
  throw new UserError(
    "OSA run needs a runtime target.",
    "Pass --sandbox <id> or --computer <id>. Use --dry-run to inspect the plan without dispatching.",
  );
}

function applyRunOverrides(
  profile: OsaRuntimeProfile,
  overrides: { provider?: string; model?: string; runtimeTarget?: string },
): OsaRuntimeProfile {
  const next: OsaRuntimeProfile = { ...profile };
  if (overrides.provider) {
    next.provider = overrides.provider;
    next.harness = { ...(next.harness ?? {}), engine: overrides.provider };
  }
  if (overrides.model) next.model = overrides.model;
  if (overrides.runtimeTarget) {
    next.runtime = { ...(next.runtime ?? {}), target: overrides.runtimeTarget };
  }
  return next;
}

function resolvedProvider(profile: OsaRuntimeProfile): string {
  return profile.provider ?? stringFromRecord(profile.harness, "engine") ?? "osa";
}

function resolvedModel(profile: OsaRuntimeProfile): string | undefined {
  if (typeof profile.model === "string") return profile.model;
  return (
    stringFromRecord(profile.model, "primary") ??
    stringFromRecord(profile.model, "id") ??
    stringFromRecord(profile.model, "default")
  );
}

function stringFromRecord(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
