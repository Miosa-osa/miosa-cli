import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { OsaDiagnostic } from "./types.js";
import { relativePath } from "./paths.js";

export function readYamlObject(
  projectRoot: string,
  filePath: string,
  diagnostics: OsaDiagnostic[],
): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "yaml.read_failed",
      message: err instanceof Error ? err.message : String(err),
      path: relativePath(projectRoot, filePath),
    });
    return {};
  }

  try {
    const value = YAML.parse(source) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    diagnostics.push({
      severity: "error",
      code: "yaml.invalid_shape",
      message: "Expected a YAML mapping/object.",
      path: relativePath(projectRoot, filePath),
    });
    return {};
  } catch (err) {
    diagnostics.push({
      severity: "error",
      code: "yaml.parse_failed",
      message: err instanceof Error ? err.message : String(err),
      path: relativePath(projectRoot, filePath),
    });
    return {};
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
