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

// Exit codes — documented contract
export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_NETWORK_ERROR = 2;
export const EXIT_AUTH_ERROR = 3;
export const EXIT_SERVER_ERROR = 4;
