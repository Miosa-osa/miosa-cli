import fs from "node:fs";
import path from "node:path";

export const APP_MANIFEST_FILES = [
  "miosa.app.yml",
  "miosa.app.yaml",
  "miosa.app.json",
] as const;

export interface MiosaAppManifest {
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
  readiness?: {
    path?: string;
    port?: number;
  };
}

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

export function parseAppManifest(
  filename: string,
  content: string,
): MiosaAppManifest {
  if (filename.endsWith(".json")) {
    const parsed = JSON.parse(content) as unknown;
    return normalizeManifest(parsed);
  }
  return normalizeManifest(parseSimpleYaml(content));
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

function parseSimpleYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();

    if (indent === 0) {
      if (rawValue === "") {
        section = {};
        root[key] = section;
      } else {
        section = null;
        root[key] = parseScalar(rawValue);
      }
    } else if (section) {
      section[key] = parseScalar(rawValue);
    }
  }

  return root;
}

function parseScalar(raw: string): unknown {
  const value = raw.replace(/^['"]|['"]$/g, "");
  if (value === "false") return false;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function normalizeManifest(value: unknown): MiosaAppManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const readiness =
    row["readiness"] && typeof row["readiness"] === "object"
      ? (row["readiness"] as Record<string, unknown>)
      : {};

  return {
    template: stringValue(row["template"] ?? row["template_id"]),
    framework: stringValue(row["framework"]),
    workdir: stringValue(row["workdir"] ?? row["workspace"] ?? row["root"]),
    install:
      row["install"] === false
        ? false
        : stringValue(row["install"] ?? row["install_command"]),
    dev: stringValue(row["dev"]),
    build: stringValue(row["build"] ?? row["build_command"]),
    start: stringValue(row["start"] ?? row["start_command"]),
    run: stringValue(row["run"] ?? row["run_command"]),
    port: numberValue(row["port"] ?? readiness["port"]),
    output: stringValue(row["output"]),
    output_path: stringValue(row["output_path"]),
    readiness: {
      path: stringValue(
        readiness["path"] ?? row["probe_path"] ?? row["health_check_path"],
      ),
      port: numberValue(readiness["port"]),
    },
  };
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
