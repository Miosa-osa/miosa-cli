import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { UserError } from "../errors.js";
import { isJsonMode } from "./util.js";

const REGISTRY_URL = "https://registry.npmjs.org/@miosa/cli/latest";
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
  version: string;
};

type PackageManager = "npm" | "pnpm" | "bun";

interface UpdateOptions {
  check?: boolean;
  dryRun?: boolean;
  manager?: PackageManager;
  to?: string;
  json?: boolean;
}

interface VersionInfo {
  current: string;
  latest: string;
  outdated: boolean;
}

export function register(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Update @miosa/cli to the latest published version")
    .option("--check", "Only check whether an update is available")
    .option("--dry-run", "Print the update command without running it")
    .option("--manager <manager>", "Package manager: npm, pnpm, or bun", parseManager, "npm")
    .option("--to <version>", "Install a specific version instead of latest")
    .option("--json", "Output as JSON")
    .action((opts: UpdateOptions) => runUpdate(opts));
}

async function runUpdate(opts: UpdateOptions): Promise<void> {
  const info = await fetchVersionInfo(opts.to);
  const manager = opts.manager ?? "npm";
  const target = opts.to ?? "latest";
  const command = installCommand(manager, target);

  if (opts.check || !info.outdated) {
    printResult(opts, {
      ok: true,
      current: info.current,
      latest: info.latest,
      outdated: info.outdated,
      command,
      updated: false,
    });
    return;
  }

  if (opts.dryRun) {
    printResult(opts, {
      ok: true,
      current: info.current,
      latest: info.latest,
      outdated: info.outdated,
      command,
      updated: false,
      dry_run: true,
    });
    return;
  }

  if (!isJsonMode(opts)) {
    console.log();
    console.log(chalk.bold("Updating MIOSA CLI"));
    console.log(`  ${chalk.dim(info.current)} → ${chalk.green(info.latest)}`);
    console.log(`  ${chalk.dim(command.join(" "))}`);
    console.log();
  }

  const [bin, ...args] = command;
  if (!bin) throw new UserError("Could not build CLI update command.");

  const result = spawnSync(bin, args, {
    stdio: isJsonMode(opts) ? "pipe" : "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const message = `${bin} exited with code ${result.status ?? "unknown"}`;
    if (isJsonMode(opts)) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: "CLI_UPDATE_FAILED",
              message,
              retryable: true,
              command,
              stderr: result.stderr?.trim() || undefined,
            },
          },
          null,
          2,
        ),
      );
      process.exit(result.status ?? 1);
    }

    throw new UserError(
      "CLI update failed.",
      `${message}. Try: ${command.join(" ")}`,
    );
  }

  printResult(opts, {
    ok: true,
    current: info.current,
    latest: info.latest,
    outdated: true,
    command,
    updated: true,
  });
}

async function fetchVersionInfo(targetVersion?: string): Promise<VersionInfo> {
  const current = pkg.version;
  const latest = targetVersion ?? (await fetchLatestVersion());
  return {
    current,
    latest,
    outdated: compareVersions(current, latest),
  };
}

async function fetchLatestVersion(): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  try {
    const response = await fetch(REGISTRY_URL, { signal: ac.signal });
    if (!response.ok) {
      throw new UserError(`Could not check latest CLI version: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { version?: string };
    if (!body.version) throw new UserError("npm registry response did not include a version.");
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

function installCommand(manager: PackageManager, target: string): string[] {
  const spec = `@miosa/cli@${target}`;
  if (manager === "pnpm") return ["pnpm", "add", "-g", spec];
  if (manager === "bun") return ["bun", "add", "-g", spec];
  return ["npm", "install", "-g", spec];
}

function parseManager(value: string): PackageManager {
  if (value === "npm" || value === "pnpm" || value === "bun") return value;
  throw new Error("manager must be npm, pnpm, or bun");
}

function compareVersions(current: string, latest: string): boolean {
  const parse = (version: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = version
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    return [major, minor, patch];
  };
  const [currentMajor, currentMinor, currentPatch] = parse(current);
  const [latestMajor, latestMinor, latestPatch] = parse(latest);
  if (latestMajor !== currentMajor) return latestMajor > currentMajor;
  if (latestMinor !== currentMinor) return latestMinor > currentMinor;
  return latestPatch > currentPatch;
}

function printResult(opts: UpdateOptions, data: Record<string, unknown>): void {
  if (isJsonMode(opts)) {
    const { ok: _ok, ...payload } = data;
    console.log(JSON.stringify({ ok: true, data: payload }, null, 2));
    return;
  }

  if (data["updated"]) {
    console.log();
    console.log(chalk.green(`Updated @miosa/cli to ${data["latest"]}`));
    console.log();
    return;
  }

  if (data["outdated"]) {
    console.log(`Update available: ${data["current"]} → ${data["latest"]}`);
    console.log(`Run: ${(data["command"] as string[]).join(" ")}`);
  } else {
    console.log(`MIOSA CLI is up to date (${data["current"]}).`);
  }
}
