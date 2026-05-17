import type { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, redactKey, getConfigPath } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

// ── Project config (.miosa.json) ─────────────────────────────────────────────

interface MiosaProjectConfig {
  version: 1;
  deploymentId: string;
  name: string;
  framework: string;
}

function loadProjectConfig(): MiosaProjectConfig | null {
  const p = path.join(process.cwd(), ".miosa.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as MiosaProjectConfig;
  } catch {
    return null;
  }
}

// ── API response shapes (permissive — API can evolve) ───────────────────────

interface ComputerRow {
  id?: string;
  name?: string;
  status?: string;
  state?: string;
  cpu_count?: number;
  memory_mb?: number;
  inserted_at?: string;
  created_at?: string;
}

interface SandboxRow {
  id?: string;
  name?: string;
  status?: string;
  state?: string;
  template_id?: string;
  inserted_at?: string;
  created_at?: string;
}

interface DeploymentRow {
  id?: string;
  name?: string;
  slug?: string;
  state?: string;
  updated_at?: string;
  current_build_id?: string | null;
}

interface AgentSessionRow {
  id?: string;
  status?: string;
  state?: string;
  computer_id?: string;
  inserted_at?: string;
  created_at?: string;
}

interface TenantRow {
  name?: string;
  slug?: string;
  plan?: string;
  email?: string;
  credit_balance?: number;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

function unwrap<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    const r = payload as Record<string, unknown>;
    if (Array.isArray(r["data"])) return r["data"] as T[];
  }
  return [];
}

async function safeGet<T>(client: MiosaClient, path: string): Promise<T[]> {
  try {
    const result = await client.apiGet<unknown>(path);
    return unwrap<T>(result);
  } catch {
    return [];
  }
}

async function safeGetOne<T>(
  client: MiosaClient,
  apiPath: string,
): Promise<T | null> {
  try {
    const result = await client.apiGet<unknown>(apiPath);
    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      const r = result as Record<string, unknown>;
      if (r["data"] !== undefined) return r["data"] as T;
      return result as T;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Time formatting ──────────────────────────────────────────────────────────

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ── Box rendering ─────────────────────────────────────────────────────────────

const BOX_WIDTH = 53;

function boxTop(): string {
  return chalk.dim("┌" + "─".repeat(BOX_WIDTH - 2) + "┐");
}

function boxBottom(): string {
  return chalk.dim("└" + "─".repeat(BOX_WIDTH - 2) + "┘");
}

function boxSep(): string {
  return chalk.dim("├" + "─".repeat(BOX_WIDTH - 2) + "┤");
}

function boxLine(content: string): string {
  // Strip ANSI to measure visible width
  const visible = content.replace(/\x1B\[[0-9;]*m/g, "");
  const pad = BOX_WIDTH - 2 - visible.length;
  return (
    chalk.dim("│") +
    " " +
    content +
    " ".repeat(Math.max(0, pad - 1)) +
    chalk.dim("│")
  );
}

function boxTitle(title: string): string {
  const pad = BOX_WIDTH - 2 - title.length;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return (
    chalk.dim("│") +
    " ".repeat(left) +
    chalk.bold(title) +
    " ".repeat(right) +
    chalk.dim("│")
  );
}

function boxEmpty(): string {
  return chalk.dim("│") + " ".repeat(BOX_WIDTH - 2) + chalk.dim("│");
}

// ── Status color helpers ──────────────────────────────────────────────────────

function colorStatus(status: string): string {
  const s = status.toLowerCase();
  if (["active", "running", "online", "live", "succeeded"].includes(s))
    return chalk.green(status);
  if (["stopped", "paused", "offline", "queued"].includes(s))
    return chalk.dim(status);
  if (["error", "failed", "crashed"].includes(s)) return chalk.red(status);
  if (["building", "pending", "starting"].includes(s))
    return chalk.yellow(status);
  return status;
}

// ── Column-aligned row helper ─────────────────────────────────────────────────

function row(name: string, status: string, meta: string, age: string): string {
  const n = name.slice(0, 14).padEnd(14);
  const s = status; // colored — don't pad (ANSI chars inflate length)
  const sVisible = status.replace(/\x1B\[[0-9;]*m/g, "").padEnd(8);
  const m = meta.slice(0, 16).padEnd(16);
  const sLen = sVisible.length - status.replace(/\x1B\[[0-9;]*m/g, "").length;
  void sLen;
  return `${n}  ${s}${"".padEnd(8 - status.replace(/\x1B\[[0-9;]*m/g, "").length)}  ${m}  ${age}`;
}

// ── Full status render ────────────────────────────────────────────────────────

interface StatusData {
  tenant: TenantRow | null;
  project: MiosaProjectConfig | null;
  computers: ComputerRow[];
  sandboxes: SandboxRow[];
  deployments: DeploymentRow[];
  agentSessions: AgentSessionRow[];
  endpoint: string;
}

function renderStatus(data: StatusData): void {
  const lines: string[] = [];

  lines.push(boxTop());
  lines.push(boxTitle("MIOSA Status"));
  lines.push(boxSep());

  // Account
  if (data.tenant) {
    const name = data.tenant.name ?? data.tenant.slug ?? "unknown";
    const plan = data.tenant.plan ?? "free";
    const acctLine = `${chalk.bold(name)} ${chalk.dim(`(${plan})`)}`;
    lines.push(boxLine(`Account:   ${acctLine}`));
  } else {
    lines.push(boxLine("Account:   " + chalk.dim("(not available)")));
  }

  // Project
  if (data.project) {
    lines.push(
      boxLine(
        `Project:   ${chalk.bold(data.project.name)} ${chalk.dim("(linked)")}`,
      ),
    );
  } else {
    lines.push(boxLine("Project:   " + chalk.dim("(no .miosa.json)")));
  }

  // Endpoint (show only if non-default)
  if (data.endpoint !== "https://api.miosa.ai") {
    lines.push(boxLine(`Endpoint:  ${chalk.dim(data.endpoint)}`));
  }

  // Computers
  if (data.computers.length > 0) {
    lines.push(boxSep());
    lines.push(boxLine(chalk.bold("Computers:")));
    for (const c of data.computers.slice(0, 6)) {
      const name = (c.name ?? c.id ?? "").slice(0, 14);
      const status = colorStatus(c.status ?? c.state ?? "unknown");
      const cpu = c.cpu_count != null ? `${c.cpu_count} CPU` : "";
      const mem = c.memory_mb != null ? `${c.memory_mb}MB` : "";
      const meta = [cpu, mem].filter(Boolean).join(" / ");
      const age = relativeTime(c.inserted_at ?? c.created_at);
      lines.push(boxLine("  " + row(name, status, meta, age)));
    }
    if (data.computers.length > 6) {
      lines.push(
        boxLine(chalk.dim(`  ... and ${data.computers.length - 6} more`)),
      );
    }
  }

  // Sandboxes
  if (data.sandboxes.length > 0) {
    lines.push(boxSep());
    lines.push(boxLine(chalk.bold("Sandboxes:")));
    for (const s of data.sandboxes.slice(0, 6)) {
      const name = (s.name ?? s.id ?? "").slice(0, 14);
      const status = colorStatus(s.status ?? s.state ?? "unknown");
      const tmpl = (s.template_id ?? "").slice(0, 16);
      const age = relativeTime(s.inserted_at ?? s.created_at);
      lines.push(boxLine("  " + row(name, status, tmpl, age)));
    }
    if (data.sandboxes.length > 6) {
      lines.push(
        boxLine(chalk.dim(`  ... and ${data.sandboxes.length - 6} more`)),
      );
    }
  }

  // Deployments
  if (data.deployments.length > 0) {
    lines.push(boxSep());
    lines.push(boxLine(chalk.bold("Deployments:")));
    for (const d of data.deployments.slice(0, 6)) {
      const name = (d.name ?? d.slug ?? d.id ?? "").slice(0, 14);
      const status = colorStatus(d.state ?? "unknown");
      const build = d.current_build_id
        ? `v${d.current_build_id.slice(0, 6)}`
        : "";
      const age = relativeTime(d.updated_at);
      lines.push(boxLine("  " + row(name, status, build, age)));
    }
    if (data.deployments.length > 6) {
      lines.push(
        boxLine(chalk.dim(`  ... and ${data.deployments.length - 6} more`)),
      );
    }
  }

  // Agent sessions
  if (data.agentSessions.length > 0) {
    lines.push(boxSep());
    lines.push(boxLine(chalk.bold("Agent Sessions:")));
    for (const a of data.agentSessions.slice(0, 4)) {
      const name = (a.id ?? "").slice(0, 14);
      const status = colorStatus(a.status ?? a.state ?? "unknown");
      const cid = (a.computer_id ?? "").slice(0, 16);
      const age = relativeTime(a.inserted_at ?? a.created_at);
      lines.push(boxLine("  " + row(name, status, cid, age)));
    }
  }

  lines.push(boxEmpty());
  lines.push(boxBottom());

  for (const line of lines) console.log(line);
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("status")
    .description(
      "Show auth, tenant, computers, sandboxes, deployments, and agent sessions",
    )
    .option("--json", "Output raw JSON (machine-readable)")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();

      if (!config.api_key) {
        if (opts.json) {
          console.log(
            JSON.stringify({ authenticated: false, config: getConfigPath() }),
          );
          return;
        }
        console.log();
        console.log(chalk.dim(`  Config:    ${getConfigPath()}`));
        console.log(chalk.dim(`  API Key:   ${redactKey(config.api_key)}`));
        console.log();
        console.log(chalk.yellow("  Not logged in. Run: miosa login"));
        console.log();
        return;
      }

      const spinner = opts.json ? null : spin("Fetching status...");
      const client = new MiosaClient(config);

      try {
        // Parallel fetch — all requests fire simultaneously
        const [tenant, computers, sandboxes, deployments] = await Promise.all([
          safeGetOne<TenantRow>(client, "/api/v1/platform/tenants/current"),
          safeGet<ComputerRow>(client, "/api/v1/computers"),
          safeGet<SandboxRow>(client, "/api/v1/sandboxes"),
          safeGet<DeploymentRow>(client, "/api/v1/deployments"),
        ]);

        // Sessions are scoped to each computer — fetch in parallel for running ones
        const runningIds = computers
          .filter((c) => (c.state ?? c.status) === "running")
          .map((c) => c.id)
          .filter((id): id is string => id !== undefined)
          .slice(0, 6); // cap parallel requests

        const sessionArrays = await Promise.all(
          runningIds.map((id) =>
            safeGet<AgentSessionRow>(
              client,
              `/api/v1/computers/${encodeURIComponent(id)}/cua/sessions`,
            ),
          ),
        );

        const agentSessions: AgentSessionRow[] = sessionArrays.flat();

        const project = loadProjectConfig();

        spinner?.stop();

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                authenticated: true,
                endpoint: config.endpoint,
                api_key: redactKey(config.api_key),
                tenant,
                project,
                computers,
                sandboxes,
                deployments,
                agent_sessions: agentSessions,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log();
        renderStatus({
          tenant,
          project,
          computers,
          sandboxes,
          deployments,
          agentSessions,
          endpoint: config.endpoint,
        });
        console.log();
      } catch (err) {
        spinner?.fail("Could not fetch status");
        handleError(err);
      }
    });
}
