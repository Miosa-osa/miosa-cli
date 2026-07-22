import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { UserError } from "./errors.js";

export const APP_MANIFEST_FILES = [
  "miosa.app.yml",
  "miosa.app.yaml",
  "miosa.app.json",
] as const;

export interface MiosaAppManifest {
  schema_version?: number;
  name?: string;
  template?: string;
  framework?: string;
  workdir?: string;
  install?: string | false;
  dev?: string;
  build?: string;
  start?: string;
  run?: string;
  port?: number;
  output?: string;
  output_path?: string;
  domain?: string;
  resources?: {
    database?: ResourceIntent;
    storage?: ResourceIntent;
    volume?: ResourceIntent;
    domain?: string;
  };
  readiness?: {
    path?: string;
    port?: number;
  };
  sandbox?: ProjectSandboxManifest;
  sync?: ProjectSyncManifest;
  dependencies?: ProjectDependenciesManifest;
  services?: Record<string, ProjectServiceManifest>;
  requirements?: ProjectRequirementsManifest;
}

export interface ProjectSandboxManifest {
  name?: string;
  template?: string;
  workdir: string;
}

export interface ProjectSyncManifest {
  exclude: string[];
}

export interface ProjectDependenciesManifest {
  install: string | false;
}

export interface ProjectServiceManifest {
  command?: string;
  cwd?: string;
  port?: number;
  health?: {
    path: string;
    timeout: number;
  };
}

export interface ProjectRequirementsManifest {
  config: string[];
  secrets: string[];
  database: boolean;
}

export interface ManifestValidationIssue {
  code: string;
  path: string;
  message: string;
  fix: string;
}

const DEFAULT_SYNC_EXCLUDES = [
  ".git",
  ".miosa",
  ".env",
  ".env.*",
  "node_modules",
  ".venv",
  "coverage",
  "dist",
] as const;

export type ResourceIntent =
  | false
  | true
  | {
      auto?: boolean;
      select?: string;
      engine?: string;
      size?: string;
      storage_mb?: number;
      region?: string;
      env_name?: string;
      [key: string]: unknown;
    };

export interface LoadedAppManifest {
  path: string;
  manifest: MiosaAppManifest;
}

export function loadAppManifest(dir: string): LoadedAppManifest | null {
  for (const file of APP_MANIFEST_FILES) {
    const fullPath = path.join(dir, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    return { path: fullPath, manifest: parseAppManifest(file, content) };
  }
  return null;
}

export function loadProjectManifest(dir: string): LoadedAppManifest {
  const loaded = loadAppManifest(dir);
  if (!loaded) {
    throw new UserError(
      `Project manifest not found in ${path.resolve(dir)}.`,
      "Create miosa.app.yml. See the sandbox development contract in README.md.",
    );
  }
  const issues = validateProjectManifest(loaded.manifest);
  if (issues.length > 0) {
    throw new UserError(
      `Invalid project manifest: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      issues.map((issue) => `${issue.code}: ${issue.fix}`).join(" "),
    );
  }
  return loaded;
}

export function parseAppManifest(
  filename: string,
  content: string,
): MiosaAppManifest {
  if (filename.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    return normalizeManifest(parsed);
  }
  return normalizeManifest(parseYaml(content) as unknown);
}

export function validateProjectManifest(
  manifest: MiosaAppManifest,
): ManifestValidationIssue[] {
  const issues: ManifestValidationIssue[] = [];
  if (manifest.schema_version !== 1) {
    issues.push({
      code: "MANIFEST_SCHEMA_UNSUPPORTED",
      path: "schema_version",
      message: "schema_version must be 1",
      fix: "Set schema_version: 1.",
    });
  }
  if (!manifest.name) {
    issues.push({
      code: "MANIFEST_NAME_REQUIRED",
      path: "name",
      message: "project name is required",
      fix: "Set name to a stable project identifier.",
    });
  }

  const install = manifest.dependencies?.install;
  if (typeof install === "string" && !isDeterministicInstall(install)) {
    issues.push({
      code: "INSTALL_NOT_DETERMINISTIC",
      path: "dependencies.install",
      message: `install command is not lockfile-strict: ${install}`,
      fix: "Use npm ci, pnpm install --frozen-lockfile, yarn install --immutable, bun install --frozen-lockfile, or a hash-locked equivalent.",
    });
  }

  const services = manifest.services ?? {};
  if (Object.keys(services).length === 0) {
    issues.push({
      code: "SERVICES_REQUIRED",
      path: "services",
      message: "at least one service is required",
      fix: "Declare a named service with command, port, and health settings.",
    });
  }
  const usedPorts = new Map<number, string>();
  for (const [name, service] of Object.entries(services)) {
    if (!service.command) {
      issues.push({
        code: "SERVICE_COMMAND_REQUIRED",
        path: `services.${name}.command`,
        message: "service command is required",
        fix: `Set services.${name}.command to the foreground process command.`,
      });
    }
    if (
      service.port == null ||
      !Number.isInteger(service.port) ||
      service.port < 1 ||
      service.port > 65535
    ) {
      issues.push({
        code: "SERVICE_PORT_INVALID",
        path: `services.${name}.port`,
        message: "service port must be an integer from 1 through 65535",
        fix: `Set services.${name}.port to the listener port.`,
      });
    } else {
      const previous = usedPorts.get(service.port);
      if (previous) {
        issues.push({
          code: "SERVICE_PORT_DUPLICATE",
          path: `services.${name}.port`,
          message: `port ${service.port} is also used by ${previous}`,
          fix: "Give every declared service a unique listener port.",
        });
      }
      usedPorts.set(service.port, name);
    }
  }
  return issues;
}

export function manifestProbePath(manifest?: MiosaAppManifest | null): string | undefined {
  return manifest?.readiness?.path;
}

export function manifestPort(manifest?: MiosaAppManifest | null): number | undefined {
  return numberValue(manifest?.port ?? manifest?.readiness?.port);
}

export function manifestStartCommand(
  manifest?: MiosaAppManifest | null,
): string | undefined {
  return stringValue(manifest?.dev ?? manifest?.start ?? manifest?.run);
}

export function manifestRunCommand(
  manifest?: MiosaAppManifest | null,
): string | undefined {
  return stringValue(manifest?.run ?? manifest?.start);
}

export function manifestBuildCommand(
  manifest?: MiosaAppManifest | null,
): string | undefined {
  return stringValue(manifest?.build);
}

export function manifestOutputPath(
  manifest?: MiosaAppManifest | null,
): string | undefined {
  return stringValue(manifest?.output_path ?? manifest?.output);
}

export function manifestDomain(
  manifest?: MiosaAppManifest | null,
): string | undefined {
  return stringValue(manifest?.domain ?? manifest?.resources?.domain);
}

export function manifestResources(
  manifest?: MiosaAppManifest | null,
): MiosaAppManifest["resources"] | undefined {
  return manifest?.resources;
}

function normalizeManifest(value: unknown): MiosaAppManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const readiness =
    row["readiness"] && typeof row["readiness"] === "object"
      ? (row["readiness"] as Record<string, unknown>)
      : {};
  const resources =
    row["resources"] && typeof row["resources"] === "object"
      ? normalizeResources(row["resources"] as Record<string, unknown>)
      : undefined;
  const sandbox = recordValue(row["sandbox"]);
  const sync = recordValue(row["sync"]);
  const dependencies = recordValue(row["dependencies"]);
  const requirements = recordValue(row["requirements"]);
  const services = normalizeServices(recordValue(row["services"]));
  const workdir = stringValue(
    sandbox?.["workdir"] ?? row["workdir"] ?? row["workspace"] ?? row["root"],
  ) ?? "/workspace";
  const install =
    dependencies?.["install"] === false || row["install"] === false
      ? false
      : stringValue(
          dependencies?.["install"] ?? row["install"] ?? row["install_command"],
        );

  return {
    schema_version: numberValue(row["schema_version"]),
    name: stringValue(row["name"]),
    template: stringValue(row["template"] ?? row["template_id"]),
    framework: stringValue(row["framework"]),
    workdir,
    install,
    dev: stringValue(row["dev"]),
    build: stringValue(row["build"] ?? row["build_command"]),
    start: stringValue(row["start"] ?? row["start_command"]),
    run: stringValue(row["run"] ?? row["run_command"]),
    port: numberValue(row["port"] ?? readiness["port"]),
    output: stringValue(row["output"]),
    output_path: stringValue(row["output_path"]),
    domain: stringValue(row["domain"]),
    resources,
    readiness: {
      path: stringValue(
        readiness["path"] ?? row["probe_path"] ?? row["health_check_path"],
      ),
      port: numberValue(readiness["port"]),
    },
    sandbox: {
      name: stringValue(sandbox?.["name"]),
      template: stringValue(sandbox?.["template"]),
      workdir,
    },
    sync: {
      exclude: uniqueStrings([
        ...DEFAULT_SYNC_EXCLUDES,
        ...stringArray(sync?.["exclude"]),
      ]),
    },
    dependencies: install === undefined ? undefined : { install },
    services,
    requirements: {
      config: stringArray(requirements?.["config"]),
      secrets: stringArray(requirements?.["secrets"]),
      database: requirements?.["database"] === true,
    },
  };
}

function normalizeServices(
  value: Record<string, unknown> | null,
): Record<string, ProjectServiceManifest> | undefined {
  if (!value) return undefined;
  const services: Record<string, ProjectServiceManifest> = {};
  for (const [name, candidate] of Object.entries(value)) {
    const row = recordValue(candidate) ?? {};
    const health = recordValue(row["health"]);
    services[name] = {
      command: stringValue(row["command"] ?? row["cmd"]),
      cwd: stringValue(row["cwd"]),
      port: numberValue(row["port"]),
      health: {
        path: stringValue(health?.["path"]) ?? "/",
        timeout: numberValue(health?.["timeout"]) ?? 120,
      },
    };
  }
  return services;
}

function isDeterministicInstall(command: string): boolean {
  if (/[;&|`<>\r\n]/.test(command) || command.includes("$(")) return false;

  return (
    /^npm\s+ci(?:\s+[^\s]+)*\s*$/.test(command) ||
    /^pnpm\s+install\b(?=[^\r\n]*--frozen-lockfile)(?:\s+[^\s]+)*\s*$/.test(command) ||
    /^yarn\s+install\b(?=[^\r\n]*(?:--immutable|--frozen-lockfile))(?:\s+[^\s]+)*\s*$/.test(command) ||
    /^bun\s+install\b(?=[^\r\n]*--frozen-lockfile)(?:\s+[^\s]+)*\s*$/.test(command) ||
    /^pip(?:3)?\s+install\b(?=[^\r\n]*(?:--require-hashes|-r\s+[^\s]+\.lock|--requirement(?:=|\s+)[^\s]+\.lock))(?:\s+[^\s]+)*\s*$/.test(
      command,
    )
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeResources(
  value: Record<string, unknown>,
): MiosaAppManifest["resources"] {
  return {
    database: resourceValue(value["database"]),
    storage: resourceValue(value["storage"]),
    volume: resourceValue(value["volume"]),
    domain: stringValue(value["domain"]),
  };
}

function resourceValue(value: unknown): ResourceIntent | undefined {
  if (value === true || value === false) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as ResourceIntent;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
