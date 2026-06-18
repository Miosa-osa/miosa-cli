import fs from "node:fs";
import path from "node:path";
import { artifactRoot } from "./paths.js";
import { buildOsaProject } from "./build.js";
import type { OsaExecutionPlan } from "./types.js";

export function createOsaPlan(options: {
  kind: "run" | "dev" | "deploy";
  target?: string;
  cwd?: string;
  runtimeTarget?: string;
  task?: string;
}): OsaExecutionPlan {
  const build = buildOsaProject({ target: options.target, cwd: options.cwd });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(build.projectRoot, build.manifestPath), "utf8"),
  ) as { agent: { name: string }; runtimeProfile?: OsaExecutionPlan["runtimeProfile"] };
  const runtimeProfile = manifest.runtimeProfile ?? {};
  const target = options.runtimeTarget ?? stringFromProfile(runtimeProfile.runtime, "target") ?? "local";

  const plan: OsaExecutionPlan = {
    version: 1,
    kind: options.kind,
    createdAt: new Date().toISOString(),
    projectRoot: build.projectRoot,
    agentName: manifest.agent.name,
    target,
    ...(options.task ? { task: options.task } : {}),
    manifestPath: build.manifestPath,
    runtimeProfile,
    requiredRuntime: true,
    steps: planSteps(options.kind),
  };

  fs.writeFileSync(
    path.join(artifactRoot(build.projectRoot), `osa-${options.kind}-plan.json`),
    `${JSON.stringify(plan, null, 2)}\n`,
    "utf8",
  );

  return plan;
}

function stringFromProfile(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function planSteps(kind: "run" | "dev" | "deploy"): OsaExecutionPlan["steps"] {
  if (kind === "run") {
    return [
      { id: "load_manifest", description: "Load compiled OSA manifest." },
      { id: "select_runtime", description: "Select OSA runtime target." },
      { id: "dispatch_task", description: "Dispatch the task to the OSA runtime." },
      { id: "stream_events", description: "Stream session events until waiting or complete." },
    ];
  }
  if (kind === "dev") {
    return [
      { id: "load_manifest", description: "Load compiled OSA manifest." },
      { id: "start_runtime", description: "Start local OSA development runtime." },
      { id: "open_console", description: "Attach CLI console to session stream." },
    ];
  }
  return [
    { id: "load_manifest", description: "Load compiled OSA manifest." },
    { id: "package_project", description: "Package OSA project files and manifest." },
    { id: "deploy_runtime", description: "Deploy to selected OSA runtime target." },
    { id: "verify_remote_info", description: "Fetch remote OSA info and compare manifest." },
  ];
}
