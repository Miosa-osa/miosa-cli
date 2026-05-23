/**
 * MIOSA CLI render vocabulary.
 *
 * Single source of truth for the visible look-and-feel: banner, status
 * icons, key/value panels, hint blocks, error envelopes, and elapsed
 * timing. Every command should compose its output from these primitives
 * so the brand stays consistent.
 *
 * Design rules:
 *   - One accent color (cyan) for the brand.
 *   - Semantic colors for status (green/yellow/red/dim).
 *   - Never print colors when not a TTY (CI, pipes) — chalk handles
 *     this automatically via FORCE_COLOR=0 / NO_COLOR; we just call it.
 *   - Plain ASCII only. No unicode that breaks in cmd.exe / Putty.
 *   - Every "section" the user sees should fit inside one of these
 *     primitives; the command does NOT reach for raw `console.log` +
 *     ad-hoc chalk except for the body of a tool result.
 */

import chalk from "chalk";

// ── Status icons ──────────────────────────────────────────────────────────
// Plain ASCII so they render everywhere. Colors applied via chalk.

export const icon = {
  ok: chalk.green("✓"),
  fail: chalk.red("✗"),
  warn: chalk.yellow("⚠"),
  info: chalk.cyan("›"),
  bullet: chalk.dim("•"),
  arrow: chalk.dim("→"),
  pending: chalk.yellow("·"),
};

// ── Brand banner ──────────────────────────────────────────────────────────

/**
 * Single-line MIOSA banner used at the top of lifecycle commands
 * (login / logout / mcp install). Compact and unobtrusive.
 *
 *   ▮▮▮ MIOSA ▮▮▮  v1.0.4
 */
export function banner(
  opts: { version?: string; subtitle?: string } = {},
): string {
  const bar = chalk.cyan("▮▮▮");
  const wordmark = chalk.bold("MIOSA");
  const version = opts.version ? chalk.dim(`  v${opts.version}`) : "";
  const subtitle = opts.subtitle ? chalk.dim(`  ${opts.subtitle}`) : "";
  return `${bar} ${wordmark} ${bar}${version}${subtitle}`;
}

// ── Key/value panel ───────────────────────────────────────────────────────

export interface KVRow {
  /** Left column label. Will be bolded. */
  label: string;
  /** Right column value. Pre-formatted; no further styling applied. */
  value: string;
  /** Optional leading icon (e.g. `icon.ok`). */
  icon?: string;
}

/**
 * Render a list of key/value rows with aligned columns. Used for the
 * "✓ Authenticated  ClinicIQ · Pro plan" output blocks.
 */
export function kvPanel(rows: KVRow[]): string {
  if (rows.length === 0) return "";
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows
    .map((r) => {
      const lead = r.icon ? `${r.icon}  ` : "   ";
      const label = chalk.bold(r.label.padEnd(labelWidth));
      return `  ${lead}${label}   ${r.value}`;
    })
    .join("\n");
}

// ── Hint block ────────────────────────────────────────────────────────────

/**
 * Suggest what the user can do next. Rendered as:
 *
 *   → Next:  miosa computers list
 *            miosa mcp install
 */
export function hintBlock(label: string, commands: string[]): string {
  if (commands.length === 0) return "";
  const head = `  ${chalk.dim("→")} ${chalk.bold(label)}`;
  const pad = " ".repeat(label.length + 5); // align with first command
  const lines = commands.map((c, i) =>
    i === 0 ? `${head}  ${chalk.cyan(c)}` : `  ${pad}${chalk.cyan(c)}`,
  );
  return lines.join("\n");
}

// ── Error envelope ────────────────────────────────────────────────────────

export interface ErrorEnvelope {
  title: string;
  body?: string;
  /** Suggested commands or doc URL. */
  suggest?: string[];
  /** Show "Run with --debug for full trace" hint. */
  withDebugHint?: boolean;
}

/**
 * Format an error in the brand's red envelope. Use this in the catch
 * block of every command instead of bare `console.error`.
 */
export function errorEnvelope(env: ErrorEnvelope): string {
  const lines: string[] = [];
  lines.push(`  ${chalk.red("✗")}  ${chalk.bold.red(env.title)}`);
  if (env.body) lines.push(`     ${chalk.dim(env.body)}`);
  if (env.suggest && env.suggest.length > 0) {
    lines.push("");
    lines.push(`  ${chalk.dim("→")} ${chalk.bold("Try")}`);
    for (const s of env.suggest) lines.push(`        ${chalk.cyan(s)}`);
  }
  if (env.withDebugHint) {
    lines.push("");
    lines.push(
      `  ${chalk.dim("Run with MIOSA_DEBUG=1 for the full stack trace.")}`,
    );
  }
  return lines.join("\n");
}

// ── Elapsed timer ─────────────────────────────────────────────────────────

/**
 * Wrap an async block and append a "Took 1.2s" line on success.
 * On error, re-throws so the caller can format its own envelope.
 */
export async function withElapsed<T>(fn: () => Promise<T>): Promise<{
  result: T;
  elapsed: string;
}> {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  return { result, elapsed: formatDuration(ms) };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// ── Composition helpers ──────────────────────────────────────────────────

/** Insert a blank line. Cheap readability tool. */
export const blank = (): void => console.log();

/** Print the banner — convenience over `console.log(banner(...))`. */
export function printBanner(
  opts: { version?: string; subtitle?: string } = {},
): void {
  console.log();
  console.log(`  ${banner(opts)}`);
  console.log();
}

/** Print the elapsed line in dim text below a successful command. */
export function printElapsed(elapsed: string): void {
  console.log();
  console.log(`  ${chalk.dim(`Took ${elapsed}`)}`);
}

/** Print a section header (dim small-caps). */
export function sectionHeader(label: string): void {
  console.log();
  console.log(`  ${chalk.dim.bold(label.toUpperCase())}`);
}
