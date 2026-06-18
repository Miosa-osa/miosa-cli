import fs from "node:fs";
import path from "node:path";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { buildOsaProject } from "./build.js";
import type { OsaBuildArtifact, OsaDiagnostic, OsaManifest } from "./types.js";

export interface PublishOsaProjectOptions {
  target?: string;
  workspace?: string;
  projectId?: string;
  name?: string;
  slug?: string;
  source?: string;
  dryRun?: boolean;
}

export interface OsaProjectPublishRequest {
  workspace_id?: string;
  project_id?: string;
  name?: string;
  slug?: string;
  source: string;
  manifest: OsaManifest;
  runtime_profile: OsaManifest["runtimeProfile"];
  diagnostics: {
    items: OsaDiagnostic[];
    errors: number;
    warnings: number;
  };
  metadata: {
    osa_project: true;
    manifest_path: string;
    diagnostics_path: string;
    build_path: string;
    project_root: string;
  };
}

export interface OsaProjectPublishResult {
  build: OsaBuildArtifact;
  request: OsaProjectPublishRequest;
  project?: Record<string, unknown>;
}

export async function publishOsaProject(
  options: PublishOsaProjectOptions = {},
): Promise<OsaProjectPublishResult> {
  const build = buildOsaProject({ target: options.target });
  const manifest = readJson<OsaManifest>(build.projectRoot, build.manifestPath, "OSA manifest");
  const diagnosticsArtifact = readJson<OsaDiagnostic[] | { items?: OsaDiagnostic[] }>(
    build.projectRoot,
    build.diagnosticsPath,
    "OSA diagnostics",
  );
  const diagnostics = Array.isArray(diagnosticsArtifact)
    ? diagnosticsArtifact
    : Array.isArray(diagnosticsArtifact.items)
      ? diagnosticsArtifact.items
      : [];

  const request: OsaProjectPublishRequest = {
    source: options.source ?? "miosa-cli",
    manifest,
    runtime_profile: manifest.runtimeProfile,
    diagnostics: {
      items: diagnostics,
      errors: build.errors,
      warnings: build.warnings,
    },
    metadata: {
      osa_project: true,
      manifest_path: build.manifestPath,
      diagnostics_path: build.diagnosticsPath,
      build_path: ".miosa/osa-build.json",
      project_root: build.projectRoot,
    },
  };

  if (options.workspace) request.workspace_id = options.workspace;
  if (options.projectId) request.project_id = options.projectId;
  if (options.name) request.name = options.name;
  if (options.slug) request.slug = options.slug;

  if (options.dryRun) return { build, request };

  const client = new MiosaClient(loadConfig());
  const response = await client.apiPost<unknown>("/api/v1/osa-projects", request);
  return { build, request, project: unwrapData(response) };
}

export async function listOsaProjects(options: {
  workspace?: string;
  projectId?: string;
  status?: string;
  limit?: string;
} = {}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (options.workspace) params.set("workspace_id", options.workspace);
  if (options.projectId) params.set("project_id", options.projectId);
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", options.limit);

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const client = new MiosaClient(loadConfig());
  const response = await client.apiGet<unknown>(`/api/v1/osa-projects${suffix}`);
  const data = unwrapList(response);
  return data;
}

export async function getOsaProject(id: string): Promise<Record<string, unknown>> {
  const client = new MiosaClient(loadConfig());
  const response = await client.apiGet<unknown>(`/api/v1/osa-projects/${encodeURIComponent(id)}`);
  return unwrapData(response);
}

function readJson<T>(projectRoot: string, relative: string, label: string): T {
  const filePath = path.join(projectRoot, relative);
  if (!fs.existsSync(filePath)) {
    throw new UserError(`${label} artifact is missing.`, "Run `miosa osa build` first.");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (isRecord(payload) && isRecord(payload["data"])) {
    return payload["data"] as Record<string, unknown>;
  }
  return isRecord(payload) ? payload : {};
}

function unwrapList(payload: unknown): Record<string, unknown>[] {
  if (isRecord(payload) && Array.isArray(payload["data"])) {
    return payload["data"] as Record<string, unknown>[];
  }
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
