import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiKey, MiosaConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".miosa");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AUTH_CACHE_FILE = path.join(CONFIG_DIR, "auth-cache.json");

const DEFAULTS: MiosaConfig = {
  endpoint: "https://api.miosa.ai",
  api_key: null,
  default_host: null,
  region: null,
  output: "text",
  tenant: null,
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
    default_host: fileConfig.default_host ?? null,
    region: process.env["MIOSA_REGION"] ?? fileConfig.region ?? null,
    output: fileConfig.output ?? DEFAULTS.output,
    tenant: process.env["MIOSA_TENANT"] ?? fileConfig.tenant ?? null,
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

  const merged = { ...existing, ...updates };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
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

export type ConfigKey = "api_url" | "region" | "output" | "default_host";

export const CONFIG_KEYS: ConfigKey[] = [
  "api_url",
  "region",
  "output",
  "default_host",
];

export const CONFIG_KEY_DESCRIPTIONS: Record<ConfigKey, string> = {
  api_url: "API base URL",
  region: "Default deployment region",
  output: "Output format (text | json)",
  default_host: "Default OpenComputers host",
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
