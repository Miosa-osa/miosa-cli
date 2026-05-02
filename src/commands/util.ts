import chalk from "chalk";
import { MiosaError } from "../errors.js";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";

export function handleError(err: unknown): never {
  if (err instanceof MiosaError) {
    console.error(chalk.red(`Error: ${err.message}`));
    if (err.hint) {
      console.error(chalk.dim(`  Hint: ${err.hint}`));
    }
    process.exit(err.exitCode);
  }
  if (err instanceof Error) {
    console.error(chalk.red(`Unexpected error: ${err.message}`));
    if (process.env["MIOSA_DEBUG"]) {
      console.error(err.stack);
    }
    process.exit(1);
  }
  console.error(chalk.red(`Unknown error: ${String(err)}`));
  process.exit(1);
}

/** Parse "host:/path" or just "host" (path defaults to "/") */
export function parseHostPath(arg: string): { host: string; path: string } {
  const colonIdx = arg.indexOf(":");
  if (colonIdx === -1) return { host: arg, path: "/" };
  return {
    host: arg.slice(0, colonIdx),
    path: arg.slice(colonIdx + 1) || "/",
  };
}

/** Parse KEY=VAL pairs into a Record */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      result[pair] = "";
    } else {
      result[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return result;
}

/** Parse duration strings like "30s", "2m", "1h" into milliseconds */
export function parseDuration(s: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(s);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const n = parseInt(match[1] ?? "0", 10);
  switch (match[2]) {
    case "ms":
      return n;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1_000; // default: seconds
  }
}

export function createClient(): MiosaClient {
  return new MiosaClient(loadConfig());
}

export function dataOf<T>(payload: unknown, fallback: T): T {
  if (isRecord(payload) && "data" in payload) return payload["data"] as T;
  return fallback;
}

export function listOf<T>(payload: unknown, keys: string[] = []): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (isRecord(payload)) {
    if (Array.isArray(payload["data"])) return payload["data"] as T[];
    for (const key of keys) {
      if (Array.isArray(payload[key])) return payload[key] as T[];
    }
  }
  return [];
}

export function objectOf<T extends Record<string, unknown>>(
  payload: unknown,
  keys: string[] = [],
): T {
  if (isRecord(payload)) {
    if (isRecord(payload["data"])) return payload["data"] as T;
    for (const key of keys) {
      if (isRecord(payload[key])) return payload[key] as T;
    }
    return payload as T;
  }
  return {} as T;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function requireKeyValuePairs(pairs: string[]): Record<string, string> {
  const parsed = parseEnvPairs(pairs);
  for (const key of Object.keys(parsed)) {
    if (!key.trim()) throw new Error("Invalid KEY=VALUE pair: empty key");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
