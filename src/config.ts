import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiKey, MiosaConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".miosa");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AUTH_CACHE_FILE = path.join(CONFIG_DIR, "auth-cache.json");
const CONTEXTS_FILE = path.join(CONFIG_DIR, "contexts.json");

const DEFAULTS: MiosaConfig = {
  endpoint: "https://api.miosa.ai",
  api_key: null,
  dns_servers: null,
  default_host: null,
  region: null,
  output: "text",
  tenant: null,
  organization: null,
  workspace: null,
  quiet: false,
  debug: false,
};

export function loadConfig(): MiosaConfig {
  let fileConfig: Partial<MiosaConfig> = {};

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      fileConfig = JSON.parse(raw) as Partial<MiosaConfig>;
    }
  } catch {
    // Corrupt config — treat as empty, will warn on access
  }

  const config: MiosaConfig = {
    endpoint:
      process.env["MIOSA_ENDPOINT"] ?? fileConfig.endpoint ?? DEFAULTS.endpoint,
    api_key:
      (process.env["MIOSA_API_KEY"] as ApiKey | undefined) ??
      fileConfig.api_key ??
      null,
    dns_servers:
      process.env["MIOSA_DNS_SERVERS"] ?? fileConfig.dns_servers ?? null,
    default_host: fileConfig.default_host ?? null,
    region: process.env["MIOSA_REGION"] ?? fileConfig.region ?? null,
    output: fileConfig.output ?? DEFAULTS.output,
    organization:
      process.env["MIOSA_ORGANIZATION"] ??
      process.env["MIOSA_TENANT"] ??
      fileConfig.tenant ??
      fileConfig.organization ??
      null,
    tenant:
      process.env["MIOSA_ORGANIZATION"] ??
      process.env["MIOSA_TENANT"] ??
      fileConfig.tenant ??
      fileConfig.organization ??
      null,
    workspace: process.env["MIOSA_WORKSPACE"] ?? fileConfig.workspace ?? null,
    quiet: truthy(process.env["MIOSA_QUIET"]) || Boolean(fileConfig.quiet),
    debug: truthy(process.env["MIOSA_DEBUG"]) || Boolean(fileConfig.debug),
  };

  return config;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function saveConfig(updates: Partial<MiosaConfig>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let existing: Partial<MiosaConfig> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(
        fs.readFileSync(CONFIG_FILE, "utf8"),
      ) as Partial<MiosaConfig>;
    }
  } catch {
    // Start fresh on corrupt config
  }

  const normalized =
    updates.tenant !== undefined && updates.organization === undefined
      ? { ...updates, organization: updates.tenant }
      : updates.organization !== undefined && updates.tenant === undefined
        ? { ...updates, tenant: updates.organization }
        : updates;
  const merged = { ...existing, ...normalized };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function clearApiKey(): void {
  saveConfig({ api_key: null });
  clearAuthCache();
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getContextsPath(): string {
  return CONTEXTS_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

// Redact API key for safe logging/display
export function redactKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 12) return "***";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

// ── Auth cache ────────────────────────────────────────────────────────────────
// Stores tenant identity locally so `whoami` is instant without a network round-trip.

export interface AuthCache {
  email: string | null;
  name: string;
  slug: string;
  plan?: string | null;
  credit_balance?: number | null;
  region: string | null;
  cached_at: string; // ISO timestamp
}

export function saveAuthCache(cache: AuthCache): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(AUTH_CACHE_FILE, 0o600);
}

export function loadAuthCache(): AuthCache | null {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) return null;
    const raw = fs.readFileSync(AUTH_CACHE_FILE, "utf8");
    return JSON.parse(raw) as AuthCache;
  } catch {
    return null;
  }
}

export function clearAuthCache(): void {
  try {
    if (fs.existsSync(AUTH_CACHE_FILE)) fs.unlinkSync(AUTH_CACHE_FILE);
  } catch {
    // Ignore — cache may already be gone
  }
}

// ── Config key allowlist ──────────────────────────────────────────────────────

export type ConfigKey =
  | "api_url"
  | "region"
  | "output"
  | "default_host"
  | "dns_servers";

export const CONFIG_KEYS: ConfigKey[] = [
  "api_url",
  "region",
  "output",
  "default_host",
  "dns_servers",
];

export const CONFIG_KEY_DESCRIPTIONS: Record<ConfigKey, string> = {
  api_url: "API base URL",
  region: "Default deployment region",
  output: "Output format (text | json)",
  default_host: "Default OpenComputers host",
  dns_servers:
    "DNS servers for resolving the API endpoint, comma-separated (restricted networks)",
};

/** Map from the user-facing key name to the internal MiosaConfig field name. */
export function configKeyToField(key: ConfigKey): keyof MiosaConfig {
  if (key === "api_url") return "endpoint";
  return key as keyof MiosaConfig;
}

export function getConfigValue(key: ConfigKey): string {
  const config = loadConfig();
  const field = configKeyToField(key);
  const val = config[field];
  if (val === null || val === undefined) return "";
  return String(val);
}

export function setConfigValue(key: ConfigKey, value: string): void {
  const field = configKeyToField(key);
  saveConfig({ [field]: value === "" ? null : value });
}

// ── Named contexts ───────────────────────────────────────────────────────────
// Contexts let users switch between personal/team/workspace defaults without
// rewriting API keys and scope flags manually.

export interface MiosaContext {
  name: string;
  endpoint: string;
  api_key: ApiKey | null;
  tenant: string | null;
  organization: string | null;
  workspace: string | null;
  region: string | null;
  default_host: string | null;
  output: string;
  created_at: string;
  updated_at: string;
}

export interface MiosaContextStore {
  active: string | null;
  contexts: Record<string, MiosaContext>;
}

export type ContextConfigUpdates = Partial<
  Pick<
    MiosaContext,
    | "endpoint"
    | "api_key"
    | "tenant"
    | "organization"
    | "workspace"
    | "region"
    | "default_host"
    | "output"
  >
>;

function emptyContextStore(): MiosaContextStore {
  return { active: null, contexts: {} };
}

export function loadContextStore(): MiosaContextStore {
  try {
    if (!fs.existsSync(CONTEXTS_FILE)) return emptyContextStore();
    const parsed = JSON.parse(fs.readFileSync(CONTEXTS_FILE, "utf8")) as Partial<MiosaContextStore>;
    return {
      active: typeof parsed.active === "string" ? parsed.active : null,
      contexts:
        parsed.contexts && typeof parsed.contexts === "object"
          ? (parsed.contexts as Record<string, MiosaContext>)
          : {},
    };
  } catch {
    return emptyContextStore();
  }
}

export function saveContextStore(store: MiosaContextStore): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONTEXTS_FILE, JSON.stringify(store, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(CONTEXTS_FILE, 0o600);
}

export function saveConfigForActiveContext(
  updates: ContextConfigUpdates,
): MiosaContext | null {
  const normalized =
    updates.tenant !== undefined && updates.organization === undefined
      ? { ...updates, organization: updates.tenant }
      : updates.organization !== undefined && updates.tenant === undefined
        ? { ...updates, tenant: updates.organization }
        : updates;
  saveConfig(normalized);

  const store = loadContextStore();
  if (!store.active) return null;
  const context = store.contexts[store.active];
  if (!context) return null;

  const updated: MiosaContext = {
    ...context,
    ...normalized,
    updated_at: new Date().toISOString(),
  };
  store.contexts[store.active] = updated;
  saveContextStore(store);
  return updated;
}

export function contextFromConfig(name: string, config = loadConfig()): MiosaContext {
  const now = new Date().toISOString();
  return {
    name,
    endpoint: config.endpoint,
    api_key: config.api_key,
    tenant: config.tenant ?? null,
    organization: config.organization ?? config.tenant ?? null,
    workspace: config.workspace ?? null,
    region: config.region ?? null,
    default_host: config.default_host ?? null,
    output: config.output,
    created_at: now,
    updated_at: now,
  };
}

export function saveNamedContext(name: string, context = contextFromConfig(name)): MiosaContext {
  const store = loadContextStore();
  const existing = store.contexts[name];
  const saved: MiosaContext = {
    ...context,
    name,
    created_at: existing?.created_at ?? context.created_at,
    updated_at: new Date().toISOString(),
  };
  store.contexts[name] = saved;
  if (!store.active) store.active = name;
  saveContextStore(store);
  return saved;
}

export function deleteNamedContext(name: string): boolean {
  const store = loadContextStore();
  if (!store.contexts[name]) return false;
  delete store.contexts[name];
  if (store.active === name) store.active = null;
  saveContextStore(store);
  return true;
}

export function applyNamedContext(name: string): MiosaContext | null {
  const store = loadContextStore();
  const context = store.contexts[name];
  if (!context) return null;
  saveConfig({
    endpoint: context.endpoint,
    api_key: context.api_key,
    tenant: context.tenant ?? context.organization,
    organization: context.tenant ?? context.organization,
    workspace: context.workspace,
    region: context.region,
    default_host: context.default_host,
    output: context.output,
  });
  store.active = name;
  saveContextStore(store);
  return context;
}
