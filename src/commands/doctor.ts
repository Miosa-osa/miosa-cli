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
import { printJson } from "./util.js";
import {
  banner,
  errorEnvelope,
  hintBlock,
  icon,
  kvPanel,
  sectionHeader,
} from "../ui/render.js";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** When true the row renders with icon.warn instead of icon.fail */
  warn?: boolean;
  /** Section this check belongs to — used to group output */
  section: "Identity" | "Network" | "Toolchain" | "Project";
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
          section: "Identity",
        });

        // ── Config file ──────────────────────────────────────────────────────
        checks.push({
          name: "Config file",
          ok: configExists(),
          detail: configExists() ? getConfigPath() : "not found",
          fix: configExists() ? undefined : "Run: miosa login",
          section: "Identity",
        });

        // ── Authentication ───────────────────────────────────────────────────
        const hasKey = Boolean(config.api_key);
        checks.push({
          name: "API key",
          ok: hasKey,
          detail: hasKey ? redactKey(config.api_key) : "not set",
          fix: hasKey ? undefined : "Run: miosa login",
          section: "Identity",
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
          section: "Network",
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
              section: "Identity",
            });
          } catch (err) {
            checks.push({
              name: "Authentication",
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
              fix: "Run: miosa login",
              section: "Identity",
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
          section: "Toolchain",
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
          warn: !pythonOk,
          section: "Toolchain",
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
          warn: !mcpInstalled,
          section: "Toolchain",
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
            warn: !mcpJson.configured,
            section: "Project",
          });
        } else {
          checks.push({
            name: ".claude/mcp.json",
            ok: false,
            detail: "not found",
            fix: "Create ~/.claude/mcp.json with miosa-mcp server config",
            warn: true,
            section: "Project",
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

        // ── Human-readable output ────────────────────────────────────────────
        const sections = [
          "Identity",
          "Network",
          "Toolchain",
          "Project",
        ] as const;

        console.log();
        console.log(`  ${banner({ subtitle: "Doctor" })}`);

        for (const section of sections) {
          const group = checks.filter((c) => c.section === section);
          if (group.length === 0) continue;

          sectionHeader(section);
          console.log(
            kvPanel(
              group.map((c) => ({
                icon: c.ok ? icon.ok : c.warn ? icon.warn : icon.fail,
                label: c.name,
                value: c.ok
                  ? chalk.dim(c.detail)
                  : c.warn
                    ? chalk.yellow(c.detail)
                    : chalk.red(c.detail),
              })),
            ),
          );
        }

        // ── Summary ──────────────────────────────────────────────────────────
        const okCount = checks.filter((c) => c.ok).length;
        const warnCount = checks.filter((c) => !c.ok && c.warn).length;
        const failCount = checks.filter((c) => !c.ok && !c.warn).length;

        const summaryParts: string[] = [chalk.green(`${okCount} ok`)];
        if (warnCount > 0) summaryParts.push(chalk.yellow(`${warnCount} warn`));
        if (failCount > 0) summaryParts.push(chalk.red(`${failCount} fail`));

        console.log();
        console.log(`  ${summaryParts.join(chalk.dim("  /  "))}`);

        // ── Fix hints for hard failures only ────────────────────────────────
        const hardfails = checks.filter((c) => !c.ok && !c.warn && c.fix);
        const softfails = checks.filter((c) => !c.ok && c.warn && c.fix);

        if (hardfails.length > 0) {
          console.log();
          console.log(
            hintBlock(
              "Fix",
              hardfails.map((c) => c.fix as string),
            ),
          );
        } else if (softfails.length > 0) {
          console.log();
          console.log(
            hintBlock(
              "Try",
              softfails.map((c) => c.fix as string),
            ),
          );
        }

        console.log();

        if (failCount > 0) {
          process.exit(1);
        }
      } catch (err) {
        console.log();
        console.log(
          errorEnvelope({
            title: "Doctor crashed",
            body: err instanceof Error ? err.message : String(err),
            withDebugHint: true,
          }),
        );
        console.log();
        process.exit(2);
      }
    });
}
