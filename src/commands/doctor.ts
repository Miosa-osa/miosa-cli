import type { Command } from "commander";
import chalk from "chalk";
import { diagnose, type Diagnosis } from "../net-diagnosis.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  configExists,
  getConfigPath,
  loadConfig,
  redactKey,
} from "../config.js";
import { MiosaClient } from "../client.js";
import {
  ActionAuthorityClient,
  actionCatalogConformance,
} from "../action-authority.js";
import { handleError, isJsonMode, printJson } from "./util.js";
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
  /**
   * Stable machine-readable id for scripting. Present on the connectivity
   * layers so a caller can branch on WHICH layer broke.
   */
  layer?: "dns" | "tcp" | "tls" | "http" | "auth";
  /**
   * True when the check could not be determined because a prerequisite failed.
   * "We could not check this" is not "this is broken", and collapsing the two
   * is what let the CLI report an active session while DNS was dead.
   */
  unknown?: boolean;
  /** Why the check was not determined. */
  skippedBecause?: string;
  /** Underlying error code (ENOTFOUND, CERT_HAS_EXPIRED, HTTP_503, ...). */
  errorCode?: string;
  latencyMs?: number;
  /** Section this check belongs to — used to group output */
  section: "Identity" | "Network" | "Authority" | "Toolchain" | "Project";
}

interface McpJsonCheck {
  found: boolean;
  configured: boolean;
  commands: McpCommandCandidate[];
}

interface McpCommandCandidate {
  command: string;
  args?: string[];
  source: string;
}

interface McpInstallCheck {
  installed: boolean;
  detail: string;
  source?: string;
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

function isMissingCommandError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT";
}

function executableExists(command: string): boolean {
  if (!command.includes(path.sep) && !command.includes("/") && !command.includes("\\")) {
    return false;
  }
  return fs.existsSync(command);
}

function parseVersion(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const match = /(?:miosa-mcp\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(trimmed);
  return match?.[1] ?? trimmed.split(/\s+/)[0] ?? null;
}

function isMcpInstalledFailure(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`;
  if (/MIOSA_API_KEY environment variable is not set/i.test(text)) return true;
  if (/Set it in your .*mcp\.json env block/i.test(text)) return true;
  if (/No module named ['"]?miosa_mcp/i.test(text)) return false;
  if (/ModuleNotFoundError/i.test(text) && /miosa_mcp/i.test(text)) return false;
  return true;
}

function collectMcpCommands(value: unknown): McpCommandCandidate[] {
  const found: McpCommandCandidate[] = [];

  const walk = (node: unknown, source: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, source);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    const command = typeof record["command"] === "string" ? record["command"] : null;
    const args = Array.isArray(record["args"])
      ? record["args"].filter((arg): arg is string => typeof arg === "string")
      : [];
    const serialized = JSON.stringify(record);

    if (command && /miosa-mcp/i.test(command)) {
      found.push({ command, args: ["--version"], source });
    } else if (command && /miosa_mcp/i.test(serialized)) {
      found.push({ command, args: [...args, "--version"], source });
    }

    for (const child of Object.values(record)) walk(child, source);
  };

  walk(value, "mcp.json");
  return found;
}

function windowsPythonScriptCandidates(env: NodeJS.ProcessEnv): McpCommandCandidate[] {
  const candidates: McpCommandCandidate[] = [];
  const roots = [
    env["LOCALAPPDATA"] ? path.join(env["LOCALAPPDATA"], "Programs", "Python") : null,
    env["APPDATA"] ? path.join(env["APPDATA"], "Python") : null,
  ].filter((root): root is string => Boolean(root));

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Python\d+/i.test(entry.name)) continue;
      const exe = path.join(root, entry.name, "Scripts", "miosa-mcp.exe");
      if (fs.existsSync(exe)) {
        candidates.push({ command: exe, args: ["--version"], source: "python-scripts" });
      }
    }
  }

  return candidates;
}

export async function detectMcpInstall(options: {
  mcpCommands?: McpCommandCandidate[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  includeDefaultCandidates?: boolean;
} = {}): Promise<McpInstallCheck> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const includeDefaultCandidates = options.includeDefaultCandidates ?? true;
  const candidates: McpCommandCandidate[] = [
    ...(options.mcpCommands ?? []),
    ...(includeDefaultCandidates
      ? [{ command: "miosa-mcp", args: ["--version"], source: "PATH" }]
      : []),
    ...(platform === "win32" ? windowsPythonScriptCandidates(env) : []),
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = `${candidate.command}\0${(candidate.args ?? []).join("\0")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const { stdout, stderr } = await execFileAsync(candidate.command, candidate.args ?? ["--version"], {
        timeout: 3000,
        env,
      });
      const version = parseVersion(`${stdout}\n${stderr}`);
      return {
        installed: true,
        detail: version ? `v${version}` : `installed (${candidate.source})`,
        source: candidate.source,
      };
    } catch (err) {
      if (isMissingCommandError(err) && !executableExists(candidate.command)) {
        continue;
      }

      const stdout = String((err as { stdout?: unknown }).stdout ?? "");
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      if (!isMcpInstalledFailure(stderr, stdout) && !executableExists(candidate.command)) {
        continue;
      }

      const reason = stderr.trim().split(/\r?\n/)[0] || stdout.trim().split(/\r?\n/)[0];
      return {
        installed: true,
        detail: reason
          ? `installed (${candidate.source}; version unavailable: ${reason})`
          : `installed (${candidate.source}; version unavailable)`,
        source: candidate.source,
      };
    }
  }

  return { installed: false, detail: "not installed" };
}

async function checkMcpJson(): Promise<McpJsonCheck> {
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
      return {
        found: true,
        configured,
        commands: collectMcpCommands(parsed).map((cmd) => ({
          ...cmd,
          source: candidate,
        })),
      };
    } catch {
      return { found: true, configured: false, commands: [] };
    }
  }
  return { found: false, configured: false, commands: [] };
}

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose CLI, auth, API reachability, and toolchain")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = isJsonMode(opts);
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

        // ── Connectivity, layer by layer ─────────────────────────────────────
        // DNS -> TCP -> TLS -> /health -> auth, each probed separately. A layer
        // that could not run because an earlier one failed reports `unknown`,
        // never `ok` and never `fail`: reporting a valid session while DNS was
        // dead is the exact defect this replaces.
        const client = hasKey ? new MiosaClient(config) : null;
        let tenantName: string | null = null;
        let tenantSlug: string | null = null;

        const diagnosis: Diagnosis = await diagnose(
          config.endpoint,
          client
            ? async () => {
                const tenant = await client.getTenant();
                tenantName = tenant.name;
                tenantSlug = tenant.slug;
                return `valid (${tenant.name}, ${tenant.slug})`;
              }
            : undefined,
        );

        for (const layer of diagnosis.layers) {
          checks.push({
            name: layer.name,
            ok: layer.state === "ok",
            unknown: layer.state === "unknown",
            skippedBecause: layer.skippedBecause,
            layer: layer.layer,
            errorCode: layer.errorCode,
            latencyMs: layer.latencyMs,
            detail:
              layer.state === "unknown"
                ? `not determined - ${layer.skippedBecause}`
                : layer.detail,
            fix: layer.fix,
            section: layer.layer === "auth" ? "Identity" : "Network",
          });
        }

        // Endpoint and tenant, reported as their own line so "which cluster am
        // I even talking to" is answerable without inference.
        checks.push({
          name: "Endpoint + tenant",
          ok: true,
          detail: tenantSlug
            ? `${config.endpoint} (tenant ${tenantName} / ${tenantSlug})`
            : `${config.endpoint} (tenant not resolved)`,
          section: "Identity",
        });

        const authOk =
          diagnosis.layers.find((l) => l.layer === "auth")?.state === "ok";

        if (client && authOk) {
          {

            try {
              const catalog = await new ActionAuthorityClient(client).catalog();
              const complete = catalog.every(
                (capability) =>
                  capability.name &&
                  capability.version &&
                  capability.fingerprint.startsWith("sha256:") &&
                  capability.risk &&
                  capability.scope &&
                  capability.approval,
              );
              const conformance = actionCatalogConformance(catalog);
              const healthy = complete && conformance.ok;
              const mismatch = [
                conformance.missing.length > 0
                  ? `missing ${conformance.missing.length}`
                  : null,
                conformance.stale.length > 0
                  ? `stale ${conformance.stale.length}`
                  : null,
                conformance.unexpected.length > 0
                  ? `unexpected ${conformance.unexpected.length}`
                  : null,
              ]
                .filter((item): item is string => item !== null)
                .join(", ");
              checks.push({
                name: "Action authority",
                ok: healthy,
                detail:
                  healthy
                    ? `${catalog.length} version-pinned capabilities, exact contract match`
                    : complete
                      ? `catalog mismatch: ${mismatch}`
                      : "catalog is empty or malformed",
                fix:
                  healthy
                    ? undefined
                    : "Upgrade the CLI and control plane to the same capability contract before enabling agent actions.",
                section: "Authority",
              });
            } catch (err) {
              checks.push({
                name: "Action authority",
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
                fix: "Upgrade the control plane and run: miosa actions catalog",
                section: "Authority",
              });
            }
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

        const mcpJson = await checkMcpJson();

        // ── miosa-mcp ────────────────────────────────────────────────────────
        const mcpInstall = await detectMcpInstall({
          mcpCommands: mcpJson.commands,
        });
        const mcpInstalled = mcpInstall.installed;
        checks.push({
          name: "miosa-mcp",
          ok: mcpInstalled,
          detail: mcpInstall.detail,
          fix: mcpInstalled
            ? undefined
            : "pip install miosa-mcp and ensure Python's Scripts directory is on PATH",
          warn: !mcpInstalled,
          section: "Toolchain",
        });

        // ── .claude/mcp.json ─────────────────────────────────────────────────
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
        if (json) {
          return printJson({
            // `ok` counts only checks that actually FAILED. A check that could
            // not be determined is reported in `unknown`, never silently folded
            // into a pass or a fail.
            ok: checks.every((c) => c.ok || c.unknown),
            unknown: checks.some((c) => c.unknown),
            // The one field a script should branch on: which layer broke first.
            // null when the whole path is clean.
            firstFailure: diagnosis.firstFailure,
            summary: diagnosis.summary,
            endpoint: {
              url: diagnosis.endpoint,
              host: diagnosis.host,
              port: diagnosis.port,
              protocol: diagnosis.protocol,
              tenant: tenantSlug,
              tenantName: tenantName,
            },
            connectivity: diagnosis.layers.map((l) => ({
              layer: l.layer,
              state: l.state,
              detail: l.detail,
              ...(l.latencyMs !== undefined ? { latencyMs: l.latencyMs } : {}),
              ...(l.errorCode ? { errorCode: l.errorCode } : {}),
              ...(l.skippedBecause ? { skippedBecause: l.skippedBecause } : {}),
              ...(l.fix ? { fix: l.fix } : {}),
            })),
            checks: checks.map((c) => ({
              name: c.name,
              // Tri-state, so a consumer can tell "broken" from "not checked".
              state: c.unknown ? "unknown" : c.ok ? "ok" : "fail",
              ok: c.ok,
              detail: c.detail,
              ...(c.layer ? { layer: c.layer } : {}),
              ...(c.errorCode ? { errorCode: c.errorCode } : {}),
              ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
              ...(c.skippedBecause ? { skippedBecause: c.skippedBecause } : {}),
              ...(c.fix ? { fix: c.fix } : {}),
            })),
          });
        }

        // ── Human-readable output ────────────────────────────────────────────
        const sections = [
          "Identity",
          "Network",
          "Authority",
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
              // An undetermined check is dimmed, not reddened. Painting "we
              // could not check this" the same colour as "this is broken" is
              // what makes a diagnosis unreadable.
              group.map((c) => ({
                icon: c.unknown
                  ? icon.warn
                  : c.ok
                    ? icon.ok
                    : c.warn
                      ? icon.warn
                      : icon.fail,
                label: c.name,
                value: c.unknown
                  ? chalk.dim(c.detail)
                  : c.ok
                    ? chalk.dim(c.detail)
                    : c.warn
                      ? chalk.yellow(c.detail)
                      : chalk.red(c.detail),
              })),
            ),
          );
        }

        // ── Summary ──────────────────────────────────────────────────────────
        const okCount = checks.filter((c) => c.ok && !c.unknown).length;
        const unknownCount = checks.filter((c) => c.unknown).length;
        const warnCount = checks.filter((c) => !c.ok && !c.unknown && c.warn).length;
        const failCount = checks.filter((c) => !c.ok && !c.unknown && !c.warn).length;

        const summaryParts: string[] = [chalk.green(`${okCount} ok`)];
        if (warnCount > 0) summaryParts.push(chalk.yellow(`${warnCount} warn`));
        if (failCount > 0) summaryParts.push(chalk.red(`${failCount} fail`));
        if (unknownCount > 0)
          summaryParts.push(chalk.dim(`${unknownCount} not determined`));

        console.log();
        console.log(`  ${summaryParts.join(chalk.dim("  /  "))}`);

        // Name the broken layer outright. The whole point of the command is to
        // answer "which layer", so it should not have to be read out of a table.
        if (diagnosis.firstFailure) {
          console.log();
          console.log(`  ${chalk.red("Fault:")} ${diagnosis.summary}`);
          const failing = diagnosis.layers.find(
            (l) => l.layer === diagnosis.firstFailure,
          );
          if (failing?.fix) console.log(`  ${chalk.dim(failing.fix)}`);
        }

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
        if (json) handleError(err);
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
