/**
 * Auto-update checker — fires async after command completion.
 * Checks npm registry for the latest @miosa/cli version once per 24h.
 * Caches the result in ~/.miosa/update-check.json.
 * Never blocks the command; errors are silently swallowed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { isJsonMode, isQuietMode } from "./cli-env.js";

const CACHE_PATH = join(homedir(), ".miosa", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = "https://registry.npmjs.org/@miosa/cli/latest";

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

function readCache(): UpdateCache | null {
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache): void {
  try {
    mkdirSync(join(homedir(), ".miosa"), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(data), "utf8");
  } catch {
    // Non-fatal — cache write failures are ignored
  }
}

function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, "").split(".").map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/**
 * Schedule an async update check that prints a notice if a newer version is
 * available. Must be called after `program.parseAsync()` so it never delays
 * command output. Uses `setImmediate` to yield first, then fires a fetch.
 */
export function scheduleUpdateCheck(currentVersion: string): void {
  if (isJsonMode() || isQuietMode()) return;

  setImmediate(() => {
    void (async () => {
      try {
        const cache = readCache();
        const now = Date.now();

        // Use cached result if still fresh
        if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
          if (compareVersions(currentVersion, cache.latestVersion)) {
            printNotice(currentVersion, cache.latestVersion);
          }
          return;
        }

        // Fetch latest from npm — 3 second timeout so this never hangs
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 3_000);
        let latestVersion: string;
        try {
          const resp = await fetch(REGISTRY_URL, { signal: ac.signal });
          if (!resp.ok) return;
          const json = (await resp.json()) as { version: string };
          latestVersion = json.version;
        } finally {
          clearTimeout(timer);
        }

        writeCache({ checkedAt: now, latestVersion });

        if (compareVersions(currentVersion, latestVersion)) {
          printNotice(currentVersion, latestVersion);
        }
      } catch {
        // Never surface update-check errors to the user
      }
    })();
  });
}

function printNotice(current: string, latest: string): void {
  console.error(
    chalk.yellow(
      `Update available: ${current} → ${latest}. Run \`miosa update\` to update.`,
    ),
  );
}
