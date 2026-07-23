export interface ComputerCheckpoint {
  id: string;
  computer_id: string;
  comment: string | null;
  size_bytes: number | null;
  state: "creating" | "ready" | "restoring" | "error";
  inserted_at: string;
  updated_at: string;
}

// Branded types for type-safe IDs
export type HostId = string & { __brand: "HostId" };
export type TenantId = string & { __brand: "TenantId" };
export type JobId = string & { __brand: "JobId" };
export type TunnelSlug = string & { __brand: "TunnelSlug" };
export type ApiKey = string & { __brand: "ApiKey" };
export type ComputerId = string & { __brand: "ComputerId" };

export function toHostId(s: string): HostId {
  return s as HostId;
}

export function toComputerId(s: string): ComputerId {
  return s as ComputerId;
}

export interface ComputerFsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number | null;
  mode: string | null;
  modified_at: string | null;
}

export interface ComputerStatResult {
  path: string;
  type: "file" | "dir" | "symlink" | "not_found";
  size: number | null;
  mode: string | null;
  modified_at: string | null;
}

export interface ComputerExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

// Config shape
export interface MiosaConfig {
  endpoint: string;
  api_key: ApiKey | null;
  default_host: string | null;
  region: string | null;
  output: string;
  tenant?: string | null;
  workspace?: string | null;
  quiet?: boolean;
  debug?: boolean;
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
  plan?: string | null;
  credit_balance?: number | null;
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
  active_version_id?: string | null;
  active_release_id?: string | null;
  running_artifact_sha256?: string | null;
  state: DeploymentState;
  auto_deploy: boolean;
  custom_domain_id: string | null;
  deployment_product?: "miosa_deploy" | "docker_deploy" | string | null;
  docker_deploy_host_id?: string | null;
  external_workspace_id?: string | null;
  external_user_id?: string | null;
  external_project_id?: string | null;
  public_url?: string | null;
  auto_subdomain?: string | null;
  docker_deploy_app?: {
    id?: string | null;
    docker_deploy_host_id?: string | null;
    app_id?: string | null;
    container_id?: string | null;
    status?: string | null;
    runtime_ip?: string | null;
    runtime_port?: number | string | null;
    public_url?: string | null;
    last_health_status?: string | null;
    deployment_version_id?: string | null;
  } | null;
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

/** Shape of the on-disk .miosa.json project config (created by `miosa deploy`) */
export interface MiosaProjectConfig {
  version: 1;
  deploymentId: DeploymentId;
  name: string;
  framework: string;
  buildCommand: string;
  runCommand: string;
  branch: string;
}

/** Shape of the on-disk .miosa.json written by `miosa link` */
export interface LocalProjectLink {
  version: 1 | 2;
  deploymentId: DeploymentId;
  name: string;
  environment: string;
  workspaceId?: string;
  projectId?: string;
}

// ── Computer event stream types ───────────────────────────────────────────────

/** Discriminated union of all event types emitted by the computer event stream. */
export type ComputerEventType =
  | "desktop_action"
  | "exec"
  | "file"
  | "screenshot"
  | "error"
  | "heartbeat"
  | "unknown";

export type DesktopActionKind =
  | "click"
  | "double_click"
  | "right_click"
  | "type"
  | "key"
  | "scroll"
  | "move"
  | "drag";

export interface DesktopActionEvent {
  type: "desktop_action";
  kind: DesktopActionKind;
  /** For click/move/drag events */
  x?: number;
  y?: number;
  /** For click events */
  button?: "left" | "right" | "middle";
  /** For type events */
  text?: string;
  /** For key events */
  key?: string;
  /** For scroll events */
  dx?: number;
  dy?: number;
  timestamp: string;
}

export interface ExecEvent {
  type: "exec";
  command: string;
  /** Present only when the command has completed */
  exit_code?: number;
  /** Milliseconds, present only when command has completed */
  duration_ms?: number;
  /** Whether this is the start or end of an exec */
  phase: "start" | "done";
  timestamp: string;
}

export interface FileEvent {
  type: "file";
  operation: "read" | "write" | "delete" | "rename" | "mkdir";
  path: string;
  /** Bytes, if known */
  size?: number;
  timestamp: string;
}

export interface ScreenshotEvent {
  type: "screenshot";
  width: number;
  height: number;
  /** Bytes */
  size: number;
  /** Base64-encoded PNG, only present when data is requested */
  data?: string;
  timestamp: string;
}

export interface ComputerErrorEvent {
  type: "error";
  message: string;
  code?: string;
  timestamp: string;
}

export interface HeartbeatEvent {
  type: "heartbeat";
  timestamp: string;
}

export interface UnknownComputerEvent {
  type: "unknown";
  raw: string;
}

export type ComputerEvent =
  | DesktopActionEvent
  | ExecEvent
  | FileEvent
  | ScreenshotEvent
  | ComputerErrorEvent
  | HeartbeatEvent
  | UnknownComputerEvent;

/** Filter category names accepted by --filter */
export type WatchFilterCategory =
  | "desktop"
  | "exec"
  | "file"
  | "screenshot"
  | "error";

// Exit codes — documented contract
export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_NETWORK_ERROR = 2;
export const EXIT_AUTH_ERROR = 3;
export const EXIT_SERVER_ERROR = 4;
