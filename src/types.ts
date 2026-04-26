// Branded types for type-safe IDs
export type HostId = string & { __brand: "HostId" };
export type TenantId = string & { __brand: "TenantId" };
export type JobId = string & { __brand: "JobId" };
export type TunnelSlug = string & { __brand: "TunnelSlug" };
export type ApiKey = string & { __brand: "ApiKey" };

export function toHostId(s: string): HostId {
  return s as HostId;
}

// Config shape
export interface MiosaConfig {
  endpoint: string;
  api_key: ApiKey | null;
  default_host: string | null;
}

// API resource types — match backend shapes exactly
export interface Host {
  id: HostId;
  name: string;
  state: HostState;
  os: string | null;
  platform: string | null;
  arch: string | null;
  hostname: string | null;
  last_heartbeat: string | null;
  host_key: string | null;
  install_command: string | null;
  tenant_id: TenantId;
  inserted_at: string;
  updated_at: string;
  telemetry?: HostTelemetry | null;
}

export type HostState =
  | "pending"
  | "online"
  | "offline"
  | "error"
  | "disconnected";

export interface HostTelemetry {
  cpu_percent: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
}

export interface Tenant {
  id: TenantId;
  name: string;
  slug: string;
  plan: string;
  credit_balance: number;
  inserted_at: string;
}

export interface TerminalTicket {
  token: string;
  url: string;
  expires_at: string;
}

export interface Job {
  id: JobId;
  cmd: string;
  args: string[];
  state: "pending" | "running" | "completed" | "failed";
  exit_code: number | null;
  cwd: string | null;
}

export interface JobCreateParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stream?: boolean;
  timeout_ms?: number;
}

export interface Tunnel {
  slug: TunnelSlug;
  port: number;
  public_url: string;
  state: "active" | "closed";
  inserted_at: string;
}

export interface TunnelCreateParams {
  port: number;
  name?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number | null;
  mode: string | null;
  modified_at: string | null;
}

export interface AgentDispatchParams {
  task: string;
  tools?: string[];
  model?: string;
  budget?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

// SSE event shapes
export type SseEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exit_code: number }
  | { type: "error"; message: string }
  | { type: "thought"; content: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "done"; result?: unknown }
  | { type: "heartbeat" }
  | { type: "unknown"; raw: string };

// API error shape from server
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  message?: string;
}

// ── Deploy product types ───────────────────────────────────────────────────

export type DeploymentId = string & { __brand: "DeploymentId" };
export type BuildId = string & { __brand: "BuildId" };

export function toDeploymentId(s: string): DeploymentId {
  return s as DeploymentId;
}

export type DeploymentState =
  | "pending"
  | "building"
  | "running"
  | "stopped"
  | "failed";

export type BuildState =
  | "queued"
  | "building"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Deployment {
  id: DeploymentId;
  tenant_id: TenantId;
  owner_id: string;
  name: string;
  slug: string;
  repo_url: string;
  repo_provider: "github";
  branch: string;
  build_command: string | null;
  run_command: string | null;
  runtime_image: string | null;
  current_build_id: BuildId | null;
  state: DeploymentState;
  auto_deploy: boolean;
  custom_domain_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DeploymentBuild {
  id: BuildId;
  deployment_id: DeploymentId;
  commit_sha: string | null;
  commit_message: string | null;
  triggered_by: "webhook" | "manual" | "scheduled";
  state: BuildState;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  log_url: string | null;
  image_digest: string | null;
  error_message: string | null;
  created_at: string;
}

export interface EnvVarPreview {
  name: string;
  preview: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDeploymentParams {
  name: string;
  repo_url: string;
  branch?: string;
  build_command?: string;
  run_command?: string;
  auto_deploy?: boolean;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** Shape of the on-disk .miosa.json project config */
export interface MiosaProjectConfig {
  version: 1;
  deploymentId: DeploymentId;
  name: string;
  framework: string;
  buildCommand: string;
  runCommand: string;
  branch: string;
}

// Exit codes — documented contract
export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_NETWORK_ERROR = 2;
export const EXIT_AUTH_ERROR = 3;
export const EXIT_SERVER_ERROR = 4;
