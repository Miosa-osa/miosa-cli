import path from "node:path";
import fs from "node:fs";

export function resolveTarget(target: string | undefined, cwd = process.cwd()): string {
  return path.resolve(cwd, target ?? ".");
}

export function relativePath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  return rel.length === 0 ? "." : rel.split(path.sep).join("/");
}

export function osaRoot(projectRoot: string): string {
  return path.join(projectRoot, "osa");
}

export function agentRoot(projectRoot: string): string {
  return path.join(projectRoot, "agent");
}

export function sourceRoot(projectRoot: string): string {
  const agent = agentRoot(projectRoot);
  const legacy = osaRoot(projectRoot);
  if (fs.existsSync(agent)) return agent;
  if (fs.existsSync(legacy)) return legacy;
  return agent;
}

export function sourceRootName(projectRoot: string): "agent" | "osa" {
  return path.basename(sourceRoot(projectRoot)) === "osa" ? "osa" : "agent";
}

export function artifactRoot(projectRoot: string): string {
  return path.join(projectRoot, ".miosa");
}
