import type { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { request } from "undici";
import {
  configExists,
  getConfigPath,
  loadConfig,
  redactKey,
} from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, printJson } from "./util.js";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const PASS = chalk.green("✓");
const FAIL = chalk.red("✗");
const WARN = chalk.yellow("~");

function mark(ok: boolean, warn = false): string {
  if (ok) return PASS;
  if (warn) return WARN;
  return FAIL;
}

async function getCommandVersion(
  cmd: string,
  args: string[],
  pattern: RegExp,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 3000 });
    const m = pattern.exec(stdout.trim());
    return m ? (m[1] ?? stdout.trim()) : stdout.trim();
  } catch {
    return null;
  }
}

async function measureLatency(url: string): Promise<number | null> {
  try {
    const start = Date.now();
    const res = await request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      bodyTimeout: 5000,
      headersTimeout: 5000,
    });
    await res.body.dump();
    return Date.now() - start;
  } catch {
    return null;
  }
}

async function checkMcpJson(): Promise<{
  found: boolean;
  configured: boolean;
}> {
  const candidates = [
    path.join(os.homedir(), ".claude", "mcp.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(process.cwd(), ".claude", "mcp.json"),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      // Check if miosa or miosa-mcp appears anywhere in the config
      const text = JSON.stringify(parsed);
      const configured = /miosa/i.test(text);
      return { found: true, configured };
    } catch {
      return { found: true, configured: false };
    }
  }
  return { found: false, configured: false };
}

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose CLI, auth, API reachability, and toolchain")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const checks: Check[] = [];

        // ── CLI version ─────────────────────────────────────────────────────
        // Read from package.json — same technique as miosa.ts entrypoint
        let cliVersion = "unknown";
        try {
          const { readFileSync } = await import("node:fs");
          const { fileURLToPath } = await import("node:url");
          const { dirname, join } = await import("node:path");
          const __dirname = dirname(fileURLToPath(import.meta.url));
          const pkg = JSON.parse(
            readFileSync(join(__dirname, "../../package.json"), "utf8"),
          ) as { version: string };
          cliVersion = pkg.version;
        } catch {
          // Non-fatal
        }
        checks.push({
          name: "CLI version",
          ok: true,
          detail: cliVersion,
        });

        // ── Config file ──────────────────────────────────────────────────────
        checks.push({
          name: "Config file",
          ok: configExists(),
          detail: configExists() ? getConfigPath() : "not found",
          fix: configExists() ? undefined : "Run: miosa login",
        });

        // ── Authentication ───────────────────────────────────────────────────
        const hasKey = Boolean(config.api_key);
        checks.push({
          name: "API key",
          ok: hasKey,
          detail: hasKey ? redactKey(config.api_key) : "not set",
          fix: hasKey ? undefined : "Run: miosa login",
        });

        // ── API reachability ─────────────────────────────────────────────────
        const healthUrl = `${config.endpoint.replace(/\/$/, "")}/health`;
        const latencyMs = await measureLatency(healthUrl);
        checks.push({
          name: "API reachable",
          ok: latencyMs !== null,
          detail:
            latencyMs !== null
              ? `${config.endpoint} (${latencyMs}ms)`
              : `${config.endpoint} (unreachable)`,
          fix:
            latencyMs === null
              ? `Check connectivity or set a custom endpoint: miosa config set api_url <url>`
              : undefined,
        });

        // ── Auth validation (only if we have a key and the API is reachable) ─
        if (hasKey && latencyMs !== null) {
          const client = new MiosaClient(config);
          try {
            const tenant = await client.getTenant();
            checks.push({
              name: "Authentication",
              ok: true,
              detail: `valid (${tenant.name}, ${tenant.slug})`,
            });
          } catch (err) {
            checks.push({
              name: "Authentication",
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
              fix: "Run: miosa login",
            });
          }
        }

        // ── Node.js version ──────────────────────────────────────────────────
        const nodeVersion = process.version; // e.g. "v22.13.0"
        const nodeMajor = parseInt(
          nodeVersion.slice(1).split(".")[0] ?? "0",
          10,
        );
        const nodeOk = nodeMajor >= 20;
        checks.push({
          name: "Node.js",
          ok: nodeOk,
          detail: nodeVersion,
          fix: nodeOk
            ? undefined
            : "Node.js 20+ required. See https://nodejs.org",
        });

        // ── Python (for MCP server) ──────────────────────────────────────────
        const pythonVersion =
          (await getCommandVersion("python3", ["--version"], /Python (\S+)/)) ??
          (await getCommandVersion("python", ["--version"], /Python (\S+)/));
        const pythonOk = pythonVersion !== null;
        checks.push({
          name: "Python",
          ok: pythonOk,
          detail: pythonVersion ? `v${pythonVersion}` : "not found",
          fix: pythonOk
            ? undefined
            : "Install Python 3.9+ from https://python.org (needed for miosa-mcp)",
        });

        // ── miosa-mcp ────────────────────────────────────────────────────────
        const mcpVersion = await getCommandVersion(
          "miosa-mcp",
          ["--version"],
          /(\S+)/,
        );
        const mcpInstalled = mcpVersion !== null;
        checks.push({
          name: "miosa-mcp",
          ok: mcpInstalled,
          detail: mcpInstalled ? `v${mcpVersion}` : "not installed",
          fix: mcpInstalled
            ? undefined
            : "pip install miosa-mcp  (MCP server for AI agent integration)",
        });

        // ── .claude/mcp.json ─────────────────────────────────────────────────
        const mcpJson = await checkMcpJson();
        if (mcpJson.found) {
          checks.push({
            name: ".claude/mcp.json",
            ok: mcpJson.configured,
            detail: mcpJson.configured
              ? "configured"
              : "found but miosa not configured",
            fix: mcpJson.configured
              ? undefined
              : "Add miosa-mcp to your .claude/mcp.json servers block",
          });
        } else {
          checks.push({
            name: ".claude/mcp.json",
            ok: false,
            detail: "not found",
            fix: "Create ~/.claude/mcp.json with miosa-mcp server config",
          });
        }

        // ── Output ───────────────────────────────────────────────────────────
        if (opts.json) {
          return printJson({
            ok: checks.every((c) => c.ok),
            checks: checks.map((c) => ({
              name: c.name,
              ok: c.ok,
              detail: c.detail,
              ...(c.fix ? { fix: c.fix } : {}),
            })),
          });
        }

        console.log();
        for (const check of checks) {
          const symbol = mark(check.ok);
          const nameCol = check.name.padEnd(22);
          console.log(`  ${symbol} ${chalk.bold(nameCol)}${check.detail}`);
          if (!check.ok && check.fix) {
            console.log(`      ${chalk.dim(check.fix)}`);
          }
        }
        console.log();

        const failures = checks.filter((c) => !c.ok);
        if (failures.length > 0) {
          console.log(
            chalk.red(`  ${failures.length} check(s) failed.`) +
              chalk.dim(" Address the items above."),
          );
          console.log();
          process.exit(1);
        }

        console.log(chalk.green("  All checks passed."));
        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}
