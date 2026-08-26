import type { Command } from "commander";
import chalk from "chalk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { NetworkError, UserError } from "../errors.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";
import type {
  ComputerEvent,
  DesktopActionEvent,
  ExecEvent,
  FileEvent,
  ScreenshotEvent,
  ComputerErrorEvent,
  WatchFilterCategory,
  ComputerId,
} from "../types.js";
import { toComputerId } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const DIVIDER = chalk.dim("─".repeat(42));

// ── SSE → ComputerEvent parser ────────────────────────────────────────────────

function parseComputerEvent(eventType: string, raw: string): ComputerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "unknown", raw };
  }

  const d = parsed as Record<string, unknown>;
  const type =
    eventType || (typeof d["type"] === "string" ? d["type"] : "unknown");

  switch (type) {
    case "desktop_action": {
      return {
        type: "desktop_action",
        kind: (d["kind"] ??
          d["action"] ??
          "click") as DesktopActionEvent["kind"],
        x: typeof d["x"] === "number" ? d["x"] : undefined,
        y: typeof d["y"] === "number" ? d["y"] : undefined,
        button: (d["button"] as DesktopActionEvent["button"]) ?? undefined,
        text: typeof d["text"] === "string" ? d["text"] : undefined,
        key: typeof d["key"] === "string" ? d["key"] : undefined,
        dx: typeof d["dx"] === "number" ? d["dx"] : undefined,
        dy: typeof d["dy"] === "number" ? d["dy"] : undefined,
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };
    }

    case "exec": {
      const hasExitCode = typeof d["exit_code"] === "number";
      return {
        type: "exec",
        command: typeof d["command"] === "string" ? d["command"] : raw,
        exit_code: hasExitCode ? (d["exit_code"] as number) : undefined,
        duration_ms:
          typeof d["duration_ms"] === "number" ? d["duration_ms"] : undefined,
        phase: hasExitCode ? "done" : "start",
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };
    }

    case "file": {
      return {
        type: "file",
        operation: (d["operation"] ?? "write") as FileEvent["operation"],
        path: typeof d["path"] === "string" ? d["path"] : "",
        size: typeof d["size"] === "number" ? d["size"] : undefined,
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };
    }

    case "screenshot": {
      return {
        type: "screenshot",
        width: typeof d["width"] === "number" ? d["width"] : 0,
        height: typeof d["height"] === "number" ? d["height"] : 0,
        size: typeof d["size"] === "number" ? d["size"] : 0,
        data: typeof d["data"] === "string" ? d["data"] : undefined,
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };
    }

    case "error": {
      return {
        type: "error",
        message:
          typeof d["message"] === "string" ? d["message"] : "Unknown error",
        code: typeof d["code"] === "string" ? d["code"] : undefined,
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };
    }

    case "heartbeat":
    case "ping":
      return {
        type: "heartbeat",
        timestamp:
          typeof d["timestamp"] === "string"
            ? d["timestamp"]
            : new Date().toISOString(),
      };

    default:
      return { type: "unknown", raw };
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────

const VALID_FILTER_CATEGORIES = new Set<WatchFilterCategory>([
  "desktop",
  "exec",
  "file",
  "screenshot",
  "error",
]);

function parseFilter(raw: string): Set<WatchFilterCategory> {
  const categories = raw.split(",").map((s) => s.trim().toLowerCase());
  const invalid = categories.filter(
    (c) => !VALID_FILTER_CATEGORIES.has(c as WatchFilterCategory),
  );
  if (invalid.length > 0) {
    throw new UserError(
      `Unknown filter categories: ${invalid.join(", ")}`,
      `Valid categories: ${[...VALID_FILTER_CATEGORIES].join(", ")}`,
    );
  }
  return new Set(categories as WatchFilterCategory[]);
}

function eventMatchesFilter(
  event: ComputerEvent,
  filter: Set<WatchFilterCategory> | null,
): boolean {
  if (filter === null) return true;
  switch (event.type) {
    case "desktop_action":
      return filter.has("desktop");
    case "exec":
      return filter.has("exec");
    case "file":
      return filter.has("file");
    case "screenshot":
      return filter.has("screenshot");
    case "error":
      return filter.has("error");
    case "heartbeat":
    case "unknown":
      return false;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatTimestamp(isoOrNow: string): string {
  try {
    return new Date(isoOrNow).toLocaleTimeString();
  } catch {
    return new Date().toLocaleTimeString();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDesktopAction(e: DesktopActionEvent): string {
  switch (e.kind) {
    case "click":
    case "double_click":
    case "right_click": {
      const label =
        e.kind === "double_click"
          ? "double_click"
          : e.kind === "right_click"
            ? "right_click"
            : "click";
      const coords =
        e.x !== undefined && e.y !== undefined ? `(${e.x}, ${e.y})` : "";
      const btn = e.button ? ` ${e.button}` : "";
      return `${chalk.blue(label.padEnd(12))} ${coords}${btn}`;
    }
    case "type":
      return `${chalk.blue("type".padEnd(12))} ${chalk.italic(JSON.stringify(e.text ?? ""))}`;
    case "key":
      return `${chalk.blue("key".padEnd(12))} ${e.key ?? ""}`;
    case "scroll": {
      const coords =
        e.x !== undefined && e.y !== undefined ? `(${e.x}, ${e.y})` : "";
      return `${chalk.blue("scroll".padEnd(12))} ${coords} dx=${e.dx ?? 0} dy=${e.dy ?? 0}`;
    }
    case "move": {
      const coords =
        e.x !== undefined && e.y !== undefined ? `(${e.x}, ${e.y})` : "";
      return `${chalk.blue("move".padEnd(12))} ${coords}`;
    }
    case "drag": {
      const coords =
        e.x !== undefined && e.y !== undefined ? `(${e.x}, ${e.y})` : "";
      return `${chalk.blue("drag".padEnd(12))} ${coords}`;
    }
  }
}

function formatExecEvent(e: ExecEvent): string {
  if (e.phase === "start") {
    return `${chalk.green("exec".padEnd(12))} ${e.command}`;
  }
  const duration =
    e.duration_ms !== undefined
      ? chalk.dim(` (${formatDuration(e.duration_ms)})`)
      : "";
  const exitLabel =
    e.exit_code === 0
      ? chalk.green(`exit=${e.exit_code}`)
      : chalk.red(`exit=${e.exit_code ?? "?"}`);
  return `${chalk.green("exec:done".padEnd(12))} ${exitLabel}${duration}`;
}

function formatFileEvent(e: FileEvent): string {
  const size = e.size !== undefined ? chalk.dim(` ${formatBytes(e.size)}`) : "";
  return `${chalk.yellow(e.operation.padEnd(12))} ${e.path}${size}`;
}

function formatScreenshotEvent(e: ScreenshotEvent): string {
  return chalk.dim(
    `${"screenshot".padEnd(12)} ${e.width}x${e.height}, ${formatBytes(e.size)}`,
  );
}

function formatErrorEvent(e: ComputerErrorEvent): string {
  const code = e.code ? chalk.dim(` [${e.code}]`) : "";
  return `${chalk.red("error".padEnd(12))} ${e.message}${code}`;
}

function renderLine(ts: string, body: string): void {
  console.log(`${chalk.dim(ts)} ${body}`);
}

// ── Screenshot saving ─────────────────────────────────────────────────────────

function saveScreenshot(
  dir: string,
  event: ScreenshotEvent,
  index: number,
): void {
  if (!event.data) return;
  try {
    const filename = `screenshot-${String(index).padStart(4, "0")}-${Date.now()}.png`;
    const filepath = join(dir, filename);
    const buf = Buffer.from(event.data, "base64");
    writeFileSync(filepath, buf);
    console.log(chalk.dim(`  Saved ${filepath}`));
  } catch (err) {
    console.error(
      chalk.red(
        `  Failed to save screenshot: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

// ── Resolve computer by ID or name ────────────────────────────────────────────

function dataOf<T>(payload: unknown): T {
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { data?: unknown }).data !== undefined
  ) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function listOf<T>(payload: unknown): T[] {
  const value = dataOf<unknown>(payload);
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function resolveComputerId(
  client: MiosaClient,
  idOrName: string,
): Promise<ComputerId> {
  // Try direct lookup first; if that 404s, fall back to list search.
  try {
    const payload = await client.apiGet<unknown>(
      `/api/v1/computers/${encodeURIComponent(idOrName)}`,
    );
    const computer = dataOf<{ id: string; name?: string }>(payload);
    if (!computer?.id) throw new Error("Computer response did not include an id");
    return toComputerId(computer.id);
  } catch {
    // Fallback: list and match by name
    const payload = await client.apiGet<unknown>("/api/v1/computers");
    const computers = listOf<{ id: string; name?: string }>(payload);
    const match = computers.find(
      (c) => c.id === idOrName || c.name === idOrName,
    );
    if (!match) {
      throw new UserError(
        `Computer not found: ${idOrName}`,
        "Run `miosa computers list` to see available computers.",
      );
    }
    return toComputerId(match.id);
  }
}

// ── Core event loop ───────────────────────────────────────────────────────────

interface WatchOptions {
  json: boolean;
  filter: Set<WatchFilterCategory> | null;
  screenshotsDir: string | null;
}

async function runEventLoop(
  client: MiosaClient,
  computerId: ComputerId,
  opts: WatchOptions,
): Promise<void> {
  let screenshotIndex = 0;

  const res = await client.watchComputerEvents(computerId);

  for await (const sseEvent of parseSse(res.body)) {
    // Re-parse raw SSE events into typed ComputerEvents
    let event: ComputerEvent;

    if (sseEvent.type === "unknown") {
      // The stream's `event:` name is the primary classifier; the payload's
      // own "type" field is only a fallback. Passing "" here threw the name
      // away, so any frame whose payload omitted "type" was reported as
      // unknown (2026-08-26).
      event = parseComputerEvent(sseEvent.event ?? "", sseEvent.raw);
    } else if (
      sseEvent.type === "heartbeat" ||
      sseEvent.type === "done" ||
      sseEvent.type === "exit"
    ) {
      // heartbeat: silently skip; done/exit: end of stream
      if (sseEvent.type === "done" || sseEvent.type === "exit") return;
      continue;
    } else if (sseEvent.type === "error") {
      event = {
        type: "error",
        message: sseEvent.message,
        timestamp: new Date().toISOString(),
      };
    } else {
      // stdout/stderr/thought/tool_call/tool_result fall through as unknown
      event = { type: "unknown", raw: JSON.stringify(sseEvent) };
    }

    // Apply filter
    if (!eventMatchesFilter(event, opts.filter)) continue;

    if (opts.json) {
      console.log(JSON.stringify(event));
      continue;
    }

    // Human-readable rendering
    switch (event.type) {
      case "desktop_action": {
        const ts = formatTimestamp(event.timestamp);
        renderLine(ts, formatDesktopAction(event));
        break;
      }
      case "exec": {
        const ts = formatTimestamp(event.timestamp);
        renderLine(ts, formatExecEvent(event));
        break;
      }
      case "file": {
        const ts = formatTimestamp(event.timestamp);
        renderLine(ts, formatFileEvent(event));
        break;
      }
      case "screenshot": {
        const ts = formatTimestamp(event.timestamp);
        renderLine(ts, formatScreenshotEvent(event));
        if (opts.screenshotsDir !== null) {
          saveScreenshot(opts.screenshotsDir, event, ++screenshotIndex);
        }
        break;
      }
      case "error": {
        const ts = formatTimestamp(event.timestamp);
        renderLine(ts, formatErrorEvent(event));
        break;
      }
      case "heartbeat":
      case "unknown":
        if (process.env["MIOSA_DEBUG"]) {
          console.log(
            chalk.dim(
              `[debug] ${event.type === "unknown" ? event.raw : "heartbeat"}`,
            ),
          );
        }
        break;
    }
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("watch <computer-id>")
    .description(
      "Stream real-time events from a Computer — agent actions, execs, file ops, screenshots",
    )
    .option("--json", "Output one JSON object per line (machine-readable)")
    .option(
      "--filter <categories>",
      "Comma-separated event categories to show: desktop, exec, file, screenshot, error",
    )
    .option(
      "--screenshots <dir>",
      "Save incoming screenshots to a local directory as PNG files",
    )
    .action(
      async (
        computerArg: string,
        opts: { json?: boolean; filter?: string; screenshots?: string },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          // Parse --filter
          let filter: Set<WatchFilterCategory> | null = null;
          if (opts.filter) {
            filter = parseFilter(opts.filter);
          }

          // Prepare screenshots directory
          let screenshotsDir: string | null = null;
          if (opts.screenshots) {
            screenshotsDir = opts.screenshots;
            mkdirSync(screenshotsDir, { recursive: true });
          }

          // Resolve computer
          const spinner = spin(`Connecting to ${computerArg}...`);
          const computerId = await resolveComputerId(client, computerArg);
          spinner.succeed(
            `Watching ${computerArg} ${chalk.dim("(connected via SSE)")}`,
          );

          if (!opts.json) {
            console.log(DIVIDER);
          }

          // Graceful Ctrl+C
          let stopping = false;
          process.on("SIGINT", () => {
            stopping = true;
            if (!opts.json) {
              console.log(chalk.dim("\n\nStopped."));
            }
            process.exit(0);
          });

          // Reconnection loop
          let attempts = 0;

          while (!stopping) {
            try {
              await runEventLoop(client, computerId, {
                json: opts.json ?? false,
                filter,
                screenshotsDir,
              });
              // Clean end-of-stream — exit normally
              break;
            } catch (err) {
              if (stopping) break;

              // Don't reconnect on auth/user errors
              if (
                err instanceof UserError ||
                (err instanceof Error && err.constructor.name === "AuthError")
              ) {
                throw err;
              }

              attempts++;
              if (attempts > MAX_RECONNECT_ATTEMPTS) {
                throw new NetworkError(
                  `Lost connection to ${computerArg} after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts.`,
                  "Check that the computer is running: miosa computers list",
                );
              }

              if (!opts.json) {
                console.log(
                  chalk.dim(
                    `\nConnection lost — reconnecting in ${RECONNECT_DELAY_MS / 1000}s ` +
                      `(attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})...`,
                  ),
                );
              }

              await new Promise<void>((resolve) =>
                setTimeout(resolve, RECONNECT_DELAY_MS),
              );
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
