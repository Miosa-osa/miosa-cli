import fs from "node:fs";
import path from "node:path";
import { UserError } from "../errors.js";
import { builtinSkills, findBuiltinSkill } from "./builtin-skills.js";
import { discoverOsaProject } from "./discovery.js";
import { resolveTarget, sourceRoot } from "./paths.js";
import type { OsaSkill } from "./types.js";

export function listSkills(options: { target?: string; cwd?: string } = {}): OsaSkill[] {
  const projectRoot = resolveTarget(options.target, options.cwd);
  const discovery = discoverOsaProject({ target: projectRoot, writeArtifacts: false });
  const byName = new Map<string, OsaSkill>();
  for (const skill of builtinSkills) byName.set(`builtin:${skill.name}`, skill);
  for (const skill of discovery.manifest.skills) byName.set(`project:${skill.name}`, skill);
  return [...byName.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "project" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function searchSkills(query: string, options: { target?: string; cwd?: string } = {}): OsaSkill[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return listSkills(options);
  return listSkills(options).filter(
    (skill) =>
      skill.name.toLowerCase().includes(normalized) ||
      skill.description.toLowerCase().includes(normalized),
  );
}

export function addSkill(options: {
  nameOrSource: string;
  target?: string;
  cwd?: string;
  force?: boolean;
}): { installed: OsaSkill; path: string } {
  const projectRoot = resolveTarget(options.target, options.cwd);
  const builtin = findBuiltinSkill(options.nameOrSource);
  if (!builtin) {
    const sourcePath = path.resolve(projectRoot, options.nameOrSource);
    if (fs.existsSync(sourcePath)) {
      throw new UserError(
        "Installing skills from local paths is not implemented yet.",
        "Use a built-in skill name for this release.",
      );
    }
    throw new UserError(
      `Unknown OSA skill: ${options.nameOrSource}`,
      `Run "miosa osa skills search ${options.nameOrSource}" to find installable skills.`,
    );
  }

  const installDir = path.join(sourceRoot(projectRoot), "skills", builtin.name);
  const skillPath = path.join(installDir, "SKILL.md");
  if (fs.existsSync(skillPath) && !options.force) {
    throw new UserError(
      `OSA skill already exists: ${builtin.name}`,
      "Pass --force to overwrite it.",
    );
  }

  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(skillPath, builtin.content, "utf8");

  return {
    installed: {
      ...builtin,
      path: path.relative(projectRoot, skillPath).split(path.sep).join("/"),
      source: "project",
      trust: "local",
    },
    path: skillPath,
  };
}
