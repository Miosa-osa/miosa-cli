import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ApiKey, MiosaConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".miosa");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: MiosaConfig = {
  endpoint: "https://api.miosa.ai",
  api_key: null,
  default_host: null,
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
  };

  return config;
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
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

// Redact API key for safe logging/display
export function redactKey(key: string | null): string {
  if (!key) return "(none)";
  if (key.length <= 12) return "***";
  return key.slice(0, 8) + "..." + key.slice(-4);
}
