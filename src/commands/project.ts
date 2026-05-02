import fs from "node:fs";
import path from "node:path";
import { UserError } from "../errors.js";
import type { DeploymentId, MiosaProjectConfig } from "../types.js";
import { toDeploymentId } from "../types.js";

const PROJECT_CONFIG_FILE = ".miosa.json";

export function loadProjectConfig(dir = process.cwd()): MiosaProjectConfig | null {
  const file = path.join(dir, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as MiosaProjectConfig;
  } catch {
    throw new UserError(
      "Could not read .miosa.json.",
      "Fix the JSON file or pass the resource ID explicitly.",
    );
  }
}

export function resolveDeploymentId(id?: string, cwd = process.cwd()): DeploymentId {
  if (id) return toDeploymentId(id);
  const cfg = loadProjectConfig(cwd);
  if (cfg) return cfg.deploymentId;
  throw new UserError(
    "No deployment ID provided and no .miosa.json found.",
    "Pass an app/deployment ID or run from a MIOSA project directory.",
  );
}
