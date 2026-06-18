import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  artifactRoot,
  relativePath,
  resolveTarget,
  sourceRoot,
  sourceRootName,
} from "./paths.js";
import type {
  OsaChannel,
  OsaComputer,
  OsaConnection,
  OsaDiagnostic,
  OsaDiscovery,
  OsaEval,
  OsaManifest,
  OsaRuntimeProfile,
  OsaRuntimeRecord,
  OsaRuntimeScalar,
  OsaSchedule,
  OsaSkill,
  OsaSubagent,
} from "./types.js";
import {
  booleanValue,
  readYamlObject,
  recordValue,
  stringArray,
  stringValue,
} from "./yaml.js";

export function discoverOsaProject(options: {
  target?: string;
  cwd?: string;
  writeArtifacts?: boolean;
} = {}): OsaDiscovery {
  const projectRoot = resolveTarget(options.target, options.cwd);
  const root = sourceRoot(projectRoot);
  const rootName = sourceRootName(projectRoot);
  const diagnostics: OsaDiagnostic[] = [];

  if (!fs.existsSync(root)) {
    diagnostics.push({
      severity: "error",
      code: "agent.root.missing",
      message: "No agent/ or legacy osa/ directory found.",
      path: "agent",
    });
  }

  const legacyAgentPath = path.join(root, "agent.yml");
  const agentConfigPath = firstExistingPath([
    path.join(root, "agent.ts"),
    path.join(root, "agent.js"),
    legacyAgentPath,
  ]);
  const agentConfig = readAgentMetadata(projectRoot, agentConfigPath, legacyAgentPath, diagnostics);

  const instructionsPath = path.join(root, "instructions.md");
  if (!fs.existsSync(instructionsPath)) {
    diagnostics.push({
      severity: "warning",
      code: "instructions.missing",
      message: `${rootName}/instructions.md is missing.`,
      path: `${rootName}/instructions.md`,
    });
  }

  const permissionsPath = path.join(root, "permissions.yml");
  const permissions = fs.existsSync(permissionsPath)
    ? readYamlObject(projectRoot, permissionsPath, diagnostics)
    : missing("warning", "permissions.missing", `${rootName}/permissions.yml is missing.`, `${rootName}/permissions.yml`, diagnostics);

  checkPermissions(projectRoot, permissionsPath, permissions, diagnostics);

  const sandboxConfigPath = firstExistingPath([
    path.join(root, "sandbox.ts"),
    path.join(root, "sandbox.js"),
    path.join(root, "sandbox", "sandbox.ts"),
    path.join(root, "sandbox", "sandbox.js"),
    path.join(root, "sandbox.yml"),
  ]);

  const manifest: OsaManifest = {
    version: 1,
    projectRoot,
    osaRoot: root,
    sourceRoot: rootName,
    agent: {
      name: stringValue(agentConfig["name"]) ?? readPackageName(projectRoot) ?? path.basename(projectRoot),
      ...(stringValue(agentConfig["description"]) ? { description: stringValue(agentConfig["description"]) } : {}),
      ...(agentModelName(agentConfig["runtimeProfile"]) ? { model: agentModelName(agentConfig["runtimeProfile"]) } : {}),
      ...(agentConfigPath ? { config: relativePath(projectRoot, agentConfigPath) } : {}),
    },
    runtimeProfile: runtimeProfileValue(agentConfig["runtimeProfile"]),
    context: {
      ...(fs.existsSync(path.join(root, "AGENTS.md")) ? { agentsMd: `${rootName}/AGENTS.md` } : {}),
      instructions: fs.existsSync(instructionsPath) ? [`${rootName}/instructions.md`] : [],
      docs: listFiles(path.join(root, "docs"), projectRoot),
    },
    skills: discoverSkills(projectRoot, root, diagnostics),
    connections: discoverConnections(projectRoot, root, diagnostics),
    channels: discoverChannels(projectRoot, root, diagnostics),
    schedules: discoverSchedules(projectRoot, root, diagnostics),
    computers: discoverComputers(projectRoot, root, diagnostics),
    subagents: discoverSubagents(projectRoot, root, diagnostics),
    hooks: moduleFiles(path.join(root, "hooks"), projectRoot).map((item) => item.path),
    sandbox: {
      ...(sandboxConfigPath ? { config: relativePath(projectRoot, sandboxConfigPath) } : {}),
      workspace: listFiles(path.join(root, "sandbox", "workspace"), projectRoot),
    },
    evals: discoverEvals(projectRoot, root),
    diagnostics: {
      errors: diagnostics.filter((item) => item.severity === "error").length,
      warnings: diagnostics.filter((item) => item.severity === "warning").length,
    },
  };

  const discovery = { manifest, diagnostics };
  if (options.writeArtifacts ?? true) writeArtifacts(projectRoot, discovery);
  return discovery;
}

function missing(
  severity: "error" | "warning",
  code: string,
  message: string,
  filePath: string,
  diagnostics: OsaDiagnostic[],
): Record<string, unknown> {
  diagnostics.push({ severity, code, message, path: filePath });
  return {};
}

function checkPermissions(
  projectRoot: string,
  permissionsPath: string,
  permissions: Record<string, unknown>,
  diagnostics: OsaDiagnostic[],
): void {
  const network = recordValue(permissions["network"]);
  if (stringValue(network["default"]) === "allow") {
    diagnostics.push({
      severity: "warning",
      code: "permissions.network.allow_all",
      message: "Network policy defaults to allow.",
      path: fs.existsSync(permissionsPath)
        ? relativePath(projectRoot, permissionsPath)
        : "agent/permissions.yml",
    });
  }
}

export function discoverSkills(
  projectRoot: string,
  root = sourceRoot(projectRoot),
  diagnostics: OsaDiagnostic[] = [],
): OsaSkill[] {
  const skillsRoot = path.join(root, "skills");
  if (!fs.existsSync(skillsRoot)) return [];
  const skills: OsaSkill[] = [];

  for (const entry of sortedDirEntries(skillsRoot)) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(skillsRoot, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = entry.name.replace(/\.md$/, "");
      const source = fs.readFileSync(fullPath, "utf8");
      const frontmatter = extractFrontmatter(source);
      skills.push({
        name,
        path: relativePath(projectRoot, fullPath),
        source: "project",
        trust: trustValue(frontmatter["trust"]),
        description:
          stringValue(frontmatter["description"]) ??
          firstContentLine(source) ??
          `Instructions for the ${name} skill.`,
        permissions: flattenPermissions(frontmatter["permissions"]),
      });
      continue;
    }

    if (!entry.isDirectory()) continue;
    const skillPath = path.join(fullPath, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;

    const source = fs.readFileSync(skillPath, "utf8");
    const frontmatter = extractFrontmatter(source);
    const name = stringValue(frontmatter["name"]) ?? entry.name;
    const description = stringValue(frontmatter["description"]);
    if (!description) {
      diagnostics.push({
        severity: "warning",
        code: "skill.description.missing",
        message: `Packaged skill ${name} is missing description frontmatter.`,
        path: relativePath(projectRoot, skillPath),
      });
    }
    skills.push({
      name,
      path: relativePath(projectRoot, skillPath),
      source: "project",
      trust: trustValue(frontmatter["trust"]),
      description: description ?? `Instructions for the ${name} skill.`,
      permissions: flattenPermissions(frontmatter["permissions"]),
    });
  }

  return skills;
}

function discoverConnections(
  projectRoot: string,
  root: string,
  diagnostics: OsaDiagnostic[],
): OsaConnection[] {
  const dir = path.join(root, "connections");
  if (!fs.existsSync(dir)) return [];
  const connections: OsaConnection[] = [];

  for (const filePath of yamlFiles(dir)) {
    const config = readYamlObject(projectRoot, filePath, diagnostics);
    const url = stringValue(config["url"]);
    const type = stringValue(config["type"]) ?? "unknown";
    const hasAuth = Object.keys(recordValue(config["auth"])).length > 0;
    warnUnauthedRemote(projectRoot, filePath, url, hasAuth, diagnostics);
    connections.push({
      name: path.basename(filePath).replace(/\.(ya?ml)$/, ""),
      path: relativePath(projectRoot, filePath),
      type,
      description: stringValue(config["description"]) ?? "",
      hasAuth,
      ...(url ? { url } : {}),
    });
  }

  for (const item of moduleFiles(dir, projectRoot)) {
    const source = fs.readFileSync(path.join(projectRoot, item.path), "utf8");
    connections.push({
      name: item.name,
      path: item.path,
      type: readStringProperty(source, "type") ?? "module",
      description: readStringProperty(source, "description") ?? "",
      hasAuth: /\bauth\s*:/.test(source),
      ...(readStringProperty(source, "baseUrl") ? { url: readStringProperty(source, "baseUrl") } : {}),
    });
  }

  return connections;
}

function discoverChannels(
  projectRoot: string,
  root: string,
  diagnostics: OsaDiagnostic[],
): OsaChannel[] {
  const dir = path.join(root, "channels");
  if (!fs.existsSync(dir)) return [];
  const channels: OsaChannel[] = [];

  for (const filePath of yamlFiles(dir)) {
    const config = readYamlObject(projectRoot, filePath, diagnostics);
    channels.push({
      name: path.basename(filePath).replace(/\.(ya?ml)$/, ""),
      path: relativePath(projectRoot, filePath),
      type: stringValue(config["type"]) ?? "unknown",
      description: stringValue(config["description"]) ?? "",
      ...(stringValue(config["entrypoint"]) ? { entrypoint: stringValue(config["entrypoint"]) } : {}),
    });
  }

  for (const item of moduleFiles(dir, projectRoot)) {
    const source = fs.readFileSync(path.join(projectRoot, item.path), "utf8");
    channels.push({
      name: item.name,
      path: item.path,
      type: readStringProperty(source, "type") ?? "module",
      description: readStringProperty(source, "description") ?? "",
      ...(readStringProperty(source, "entrypoint") ? { entrypoint: readStringProperty(source, "entrypoint") } : {}),
    });
  }

  return channels;
}

function discoverSchedules(
  projectRoot: string,
  root: string,
  diagnostics: OsaDiagnostic[],
): OsaSchedule[] {
  const dir = path.join(root, "schedules");
  if (!fs.existsSync(dir)) return [];
  const schedules: OsaSchedule[] = [];

  for (const filePath of yamlFiles(dir)) {
    const config = readYamlObject(projectRoot, filePath, diagnostics);
    schedules.push({
      name: stringValue(config["name"]) ?? path.basename(filePath).replace(/\.(ya?ml)$/, ""),
      path: relativePath(projectRoot, filePath),
      ...(stringValue(config["cron"]) ? { cron: stringValue(config["cron"]) } : {}),
      ...(stringValue(config["prompt"]) ? { prompt: stringValue(config["prompt"]) } : {}),
    });
  }

  for (const filePath of markdownFiles(dir)) {
    const source = fs.readFileSync(filePath, "utf8");
    const frontmatter = extractFrontmatter(source);
    schedules.push({
      name: path.basename(filePath).replace(/\.md$/, ""),
      path: relativePath(projectRoot, filePath),
      ...(stringValue(frontmatter["cron"]) ? { cron: stringValue(frontmatter["cron"]) } : {}),
      prompt: stripFrontmatter(source).trim(),
    });
  }

  for (const item of moduleFiles(dir, projectRoot)) {
    const source = fs.readFileSync(path.join(projectRoot, item.path), "utf8");
    schedules.push({
      name: item.name,
      path: item.path,
      ...(readStringProperty(source, "cron") ? { cron: readStringProperty(source, "cron") } : {}),
    });
  }

  return schedules;
}

function discoverComputers(
  projectRoot: string,
  root: string,
  diagnostics: OsaDiagnostic[],
): OsaComputer[] {
  const dir = path.join(root, "computers");
  if (!fs.existsSync(dir)) return [];
  const computers: OsaComputer[] = [];

  for (const filePath of yamlFiles(dir)) {
    const config = readYamlObject(projectRoot, filePath, diagnostics);
    const capabilities = Object.entries(recordValue(config["capabilities"]))
      .filter(([, value]) => value === true)
      .map(([key]) => key);
    computers.push({
      name: path.basename(filePath).replace(/\.(ya?ml)$/, ""),
      path: relativePath(projectRoot, filePath),
      enabled: booleanValue(config["enabled"]),
      ...(stringValue(config["kind"]) ? { kind: stringValue(config["kind"]) } : {}),
      ...(stringValue(config["size"]) ? { size: stringValue(config["size"]) } : {}),
      capabilities,
    });
  }

  return computers;
}

function discoverSubagents(
  projectRoot: string,
  root: string,
  diagnostics: OsaDiagnostic[],
): OsaSubagent[] {
  const dir = path.join(root, "subagents");
  if (!fs.existsSync(dir)) return [];
  const subagents: OsaSubagent[] = [];

  for (const entry of sortedDirEntries(dir)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const subagentRoot = path.join(dir, entry.name);
    const legacyAgentPath = path.join(subagentRoot, "agent.yml");
    const agentPath = firstExistingPath([
      path.join(subagentRoot, "agent.ts"),
      path.join(subagentRoot, "agent.js"),
      legacyAgentPath,
    ]);
    const config = readAgentMetadata(projectRoot, agentPath, legacyAgentPath, diagnostics);
    const description = stringValue(config["description"]);
    if (!description) {
      diagnostics.push({
        severity: "error",
        code: "subagent.description.missing",
        message: `Subagent ${entry.name} is missing a description.`,
        path: agentPath ? relativePath(projectRoot, agentPath) : relativePath(projectRoot, subagentRoot),
      });
    }
    const instructionsPath = path.join(subagentRoot, "instructions.md");
    subagents.push({
      name: stringValue(config["name"]) ?? entry.name,
      path: relativePath(projectRoot, subagentRoot),
      ...(description ? { description } : {}),
      ...(stringValue(config["model"]) ? { model: stringValue(config["model"]) } : {}),
      ...(agentPath ? { config: relativePath(projectRoot, agentPath) } : {}),
      ...(fs.existsSync(instructionsPath) ? { instructions: relativePath(projectRoot, instructionsPath) } : {}),
    });
  }

  return subagents;
}

function discoverEvals(projectRoot: string, root: string): OsaEval[] {
  return Array.from(new Set([...listFiles(path.join(projectRoot, "evals"), projectRoot), ...listFiles(path.join(root, "evals"), projectRoot)]))
    .filter((filePath) => /\.(ya?ml|json|md|ts)$/.test(filePath))
    .map((filePath) => ({
      name: path.basename(filePath).replace(/\.(ya?ml|json|md|ts)$/, ""),
      path: filePath,
    }));
}

function listFiles(dir: string, projectRoot: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of sortedDirEntries(dir)) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(fullPath, projectRoot));
    } else if (entry.isFile() && entry.name !== ".gitkeep") {
      result.push(relativePath(projectRoot, fullPath));
    }
  }
  return result;
}

function yamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return sortedDirEntries(dir)
    .filter((entry) => entry.isFile() && /\.(ya?ml)$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function markdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return sortedDirEntries(dir)
    .filter((entry) => entry.isFile() && /\.md$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function moduleFiles(dir: string, projectRoot: string): Array<{ name: string; path: string }> {
  if (!fs.existsSync(dir)) return [];
  return sortedDirEntries(dir)
    .filter((entry) => entry.isFile() && /\.(mjs|js|ts)$/.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      return {
        name: entry.name.replace(/\.(mjs|js|ts)$/, ""),
        path: relativePath(projectRoot, fullPath),
      };
    });
}

function sortedDirEntries(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

function extractFrontmatter(source: string): Record<string, unknown> {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  try {
    const value = YAML.parse(source.slice(3, end)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stripFrontmatter(source: string): string {
  if (!source.startsWith("---")) return source;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return source;
  return source.slice(end + 4).replace(/^\r?\n/, "");
}

function firstContentLine(source: string): string | undefined {
  return stripFrontmatter(source)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[#>*-]\s*/, ""))
    .find((line) => line.length > 0 && line !== "---");
}

function trustValue(value: unknown): OsaSkill["trust"] {
  return value === "builtin" ||
    value === "verified" ||
    value === "workspace" ||
    value === "third_party"
    ? value
    : "local";
}

function flattenPermissions(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return stringArray(value);
  const record = recordValue(value);
  return Object.entries(record).flatMap(([key, raw]) =>
    stringArray(raw).map((item) => `${key}:${item}`),
  );
}

function warnUnauthedRemote(
  projectRoot: string,
  filePath: string,
  url: string | undefined,
  hasAuth: boolean,
  diagnostics: OsaDiagnostic[],
): void {
  if (url && !isLocalUrl(url) && !hasAuth) {
    diagnostics.push({
      severity: "warning",
      code: "connection.auth.missing",
      message: "Non-local connection has no auth declaration.",
      path: relativePath(projectRoot, filePath),
    });
  }
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url);
}

function writeArtifacts(projectRoot: string, discovery: OsaDiscovery): void {
  const dir = artifactRoot(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "osa-manifest.json"),
    `${JSON.stringify(discovery.manifest, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "osa-diagnostics.json"),
    `${JSON.stringify({ version: 1, items: discovery.diagnostics }, null, 2)}\n`,
    "utf8",
  );
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((filePath) => fs.existsSync(filePath));
}

function readAgentMetadata(
  projectRoot: string,
  agentPath: string | undefined,
  legacyAgentPath: string,
  diagnostics: OsaDiagnostic[],
): Record<string, unknown> {
  if (fs.existsSync(legacyAgentPath)) {
    const config = readYamlObject(projectRoot, legacyAgentPath, diagnostics);
    return {
      ...config,
      runtimeProfile: legacyRuntimeProfile(config),
    };
  }
  if (!agentPath || !fs.existsSync(agentPath)) return {};
  const source = fs.readFileSync(agentPath, "utf8");
  const runtimeProfile = readRuntimeProfile(source);
  return {
    ...(readStringProperty(source, "name") ? { name: readStringProperty(source, "name") } : {}),
    ...(readStringProperty(source, "description") ? { description: readStringProperty(source, "description") } : {}),
    runtimeProfile,
  };
}

function readStringProperty(source: string, property: string): string | undefined {
  const pattern = new RegExp(`${property}:\\s*["']([^"']+)["']`);
  return pattern.exec(source)?.[1];
}

function readRuntimeProfile(source: string): OsaRuntimeProfile {
  const model = readModelConfig(source);
  const harness = readObjectConfig(source, "harness");
  const runtime = readObjectConfig(source, "runtime");
  const sandbox = readObjectConfig(source, "sandbox");
  const policy = readObjectConfig(source, "policy");
  const capabilities = readObjectConfig(source, "capabilities");
  const provider = readStringProperty(source, "provider") ?? stringField(harness, "engine");

  return compactProfile({
    ...(model !== undefined ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(harness ? { harness } : {}),
    ...(runtime ? { runtime } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(policy ? { policy } : {}),
    ...(capabilities ? { capabilities } : {}),
  });
}

function legacyRuntimeProfile(config: Record<string, unknown>): OsaRuntimeProfile {
  const profile: OsaRuntimeProfile = {};
  const model = stringValue(config["model"]);
  const provider = stringValue(config["provider"]);
  const runtime = recordValue(config["runtime"]);
  const sandbox = recordValue(config["sandbox"]);
  if (model) profile.model = model;
  if (provider) profile.provider = provider;
  if (Object.keys(runtime).length > 0) profile.runtime = runtimeProfileRecord(runtime);
  if (Object.keys(sandbox).length > 0) profile.sandbox = runtimeProfileRecord(sandbox);
  return profile;
}

function readModelConfig(source: string): string | OsaRuntimeRecord | undefined {
  const block = readObjectBlock(source, "model");
  if (!block) return readStringProperty(source, "model");
  return compactRecord({
    ...(readStringInBlock(block, "primary") ? { primary: readStringInBlock(block, "primary") } : {}),
    ...(readStringInBlock(block, "id") ? { id: readStringInBlock(block, "id") } : {}),
    ...(readStringInBlock(block, "default") ? { default: readStringInBlock(block, "default") } : {}),
    ...(readStringArrayInBlock(block, "fallback") ? { fallback: readStringArrayInBlock(block, "fallback") } : {}),
  });
}

function readObjectConfig(source: string, property: string): OsaRuntimeRecord | undefined {
  const block = readObjectBlock(source, property);
  if (!block) return undefined;
  const record: OsaRuntimeRecord = {};

  for (const key of [
    "engine",
    "mode",
    "target",
    "durability",
    "isolation",
    "backend",
    "network",
    "profile",
  ]) {
    const value = readStringInBlock(block, key);
    if (value) record[key] = value;
  }

  for (const key of ["durable", "checkpointing", "streaming", "codeEditing", "shell", "browser", "github"]) {
    const value = readBooleanInBlock(block, key);
    if (value !== undefined) record[key] = value;
  }

  for (const key of ["allowed", "approvals", "required"]) {
    const value = readStringArrayInBlock(block, key);
    if (value) record[key] = value;
  }

  const resourcesBlock = readObjectBlock(block, "resources");
  if (resourcesBlock) {
    const resources: OsaRuntimeRecord = {};
    for (const key of ["cpu", "memoryGb", "diskGb", "gpu"]) {
      const number = readNumberInBlock(resourcesBlock, key);
      const string = readStringInBlock(resourcesBlock, key);
      if (number !== undefined) resources[key] = number;
      else if (string) resources[key] = string;
    }
    if (Object.keys(resources).length > 0) record["resources"] = resources;
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

function readObjectBlock(source: string, property: string): string | undefined {
  const pattern = new RegExp(`${property}:\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("{", match.index);
  if (open === -1) return undefined;

  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

function readStringInBlock(block: string, property: string): string | undefined {
  return readStringProperty(block, property);
}

function readBooleanInBlock(block: string, property: string): boolean | undefined {
  const pattern = new RegExp(`${property}:\\s*(true|false)\\b`);
  const value = pattern.exec(block)?.[1];
  return value === "true" ? true : value === "false" ? false : undefined;
}

function readNumberInBlock(block: string, property: string): number | undefined {
  const pattern = new RegExp(`${property}:\\s*(\\d+(?:\\.\\d+)?)\\b`);
  const raw = pattern.exec(block)?.[1];
  return raw ? Number(raw) : undefined;
}

function readStringArrayInBlock(block: string, property: string): string[] | undefined {
  const pattern = new RegExp(`${property}:\\s*\\[([^\\]]*)\\]`);
  const body = pattern.exec(block)?.[1];
  if (!body) return undefined;
  const quotedValue = new RegExp("[\"']([^\"']+)[\"']", "g");
  const values = Array.from(body.matchAll(quotedValue))
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string");
  return values.length > 0 ? values : undefined;
}

function runtimeProfileValue(value: unknown): OsaRuntimeProfile {
  return isRuntimeProfile(value) ? value : {};
}

function runtimeProfileRecord(value: Record<string, unknown>): OsaRuntimeRecord {
  const record: OsaRuntimeRecord = {};
  for (const [key, raw] of Object.entries(value)) {
    const next = runtimeProfileEntry(raw);
    if (next !== undefined) record[key] = next;
  }
  return record;
}

function runtimeProfileEntry(
  value: unknown,
): OsaRuntimeScalar | OsaRuntimeScalar[] | OsaRuntimeRecord | OsaRuntimeRecord[] | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (item): item is OsaRuntimeScalar =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null,
    );
    return scalars.length === value.length ? scalars : undefined;
  }
  if (value && typeof value === "object") {
    return runtimeProfileRecord(value as Record<string, unknown>);
  }
  return undefined;
}

function isRuntimeProfile(value: unknown): value is OsaRuntimeProfile {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactProfile(profile: OsaRuntimeProfile): OsaRuntimeProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => {
      if (value === undefined) return false;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value).length > 0;
      }
      return true;
    }),
  ) as OsaRuntimeProfile;
}

function compactRecord(record: OsaRuntimeRecord): OsaRuntimeRecord | undefined {
  const compact = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function stringField(record: OsaRuntimeRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function agentModelName(value: unknown): string | undefined {
  const profile = runtimeProfileValue(value);
  if (typeof profile.model === "string") return profile.model;
  if (profile.model && typeof profile.model === "object") {
    for (const key of ["primary", "id", "default"]) {
      const candidate = profile.model[key];
      if (typeof candidate === "string") return candidate;
    }
  }
  return undefined;
}

function readPackageName(projectRoot: string): string | undefined {
  const packagePath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && pkg.name.trim().length > 0 ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}
