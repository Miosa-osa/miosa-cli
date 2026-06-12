/**
 * miosa shell <computer-id>
 *
 * Hybrid interactive session: PTY for shell commands + desktop API for
 * `desktop <action>` lines. Unique to MIOSA — SSH and desktop control in one.
 *
 * PTY lifecycle:
 *   POST /api/v1/computers/{id}/terminal   → { id, ws_url }
 *   WebSocket ws_url                        → raw terminal I/O
 *
 * Desktop commands are intercepted client-side and dispatched to:
 *   /api/v1/computers/{id}/desktop/{action}
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import WebSocket from "ws";
import chalk from "chalk";
import { request } from "undici";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";
import { getTerminalSize } from "../pty/raw-mode.js";
import { NetworkError, mapHttpError } from "../errors.js";
import type { ComputerId } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PtyTicket {
  id: string;
  ws_url: string;
}

interface ComputerSummary {
  id: ComputerId;
  name: string;
  state: string;
  image?: string | null;
  cpu?: number | null;
  memory_mb?: number | null;
  vcpu?: number | null;
  ram_mb?: number | null;
  cpu_count?: number | null;
  // Accept any additional fields from the API
  [key: string]: unknown;
}

function listOf<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload !== null &&
    typeof payload === "object" &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

async function resolveComputer(
  client: MiosaClient,
  nameOrId: string,
): Promise<ComputerSummary | null> {
  try {
    const payload = await client.apiGet<unknown>("/api/v1/computers");
    const computers = listOf<ComputerSummary>(payload);
    return (
      computers.find(
        (computer) => computer.id === nameOrId || computer.name === nameOrId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

type DesktopSubcommand =
  | { action: "screenshot" }
  | { action: "click"; x: number; y: number; button: string }
  | { action: "type"; text: string }
  | { action: "open"; app: string }
  | { action: "windows" }
  | { action: "unknown"; raw: string };

// ---------------------------------------------------------------------------
// PTY creation
// ---------------------------------------------------------------------------

async function createPty(
  endpoint: string,
  apiKey: string,
  computerId: string,
): Promise<PtyTicket> {
  let res;
  try {
    res = await request(
      `${endpoint}/api/v1/computers/${encodeURIComponent(computerId)}/terminal`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "@miosa/cli/0.1.0",
        },
        body: JSON.stringify({
          cmd: "/bin/bash",
          env: { TERM: "xterm-256color" },
        }),
      },
    );
  } catch (err) {
    throw new NetworkError(
      `Network error creating PTY: ${err instanceof Error ? err.message : String(err)}`,
      "Check your connection and endpoint: miosa status",
    );
  }
  if (res.statusCode >= 400) {
    const raw = await res.body.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { message: raw || `HTTP ${res.statusCode}` };
    }
    throw mapHttpError(res.statusCode, body, raw);
  }
  const payload = (await res.body.json()) as {
    data?: PtyTicket;
    id?: string;
    ws_url?: string;
  };
  // Support both wrapped {data: {...}} and flat responses
  const ticket: PtyTicket =
    payload.data ??
    (payload.id && payload.ws_url
      ? { id: payload.id, ws_url: payload.ws_url }
      : (() => {
          throw new Error("Invalid PTY response: missing id or ws_url");
        })());
  return ticket;
}

// ---------------------------------------------------------------------------
// Desktop API dispatch
// ---------------------------------------------------------------------------

async function desktopRequest(
  endpoint: string,
  apiKey: string,
  computerId: string,
  sub: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const method = body !== undefined ? "POST" : "GET";
  let res;
  try {
    res = await request(
      `${endpoint}/api/v1/computers/${encodeURIComponent(computerId)}/desktop/${sub}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "@miosa/cli/0.1.0",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
    );
  } catch (err) {
    throw new NetworkError(
      `Network error calling desktop/${sub}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.statusCode >= 400) {
    const raw = await res.body.text();
    let errBody: Record<string, unknown> = {};
    try {
      errBody = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      errBody = { message: raw || `HTTP ${res.statusCode}` };
    }
    throw mapHttpError(res.statusCode, errBody, raw);
  }
  // Screenshot returns binary — we return the raw buffer for that path
  if (sub === "screenshot") {
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
      );
    }
    return Buffer.concat(chunks);
  }
  return res.body.json();
}

// ---------------------------------------------------------------------------
// Desktop command parser
// ---------------------------------------------------------------------------

function parseDesktopCommand(line: string): DesktopSubcommand {
  // line is already stripped of leading "desktop "
  const parts = line.trim().split(/\s+/);
  const sub = parts[0] ?? "";

  switch (sub) {
    case "screenshot":
      return { action: "screenshot" };

    case "click": {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const button = parts[3] ?? "left";
      if (isNaN(x) || isNaN(y)) return { action: "unknown", raw: line };
      return { action: "click", x, y, button };
    }

    case "type": {
      // Reconstruct text: everything after "type ", strip optional outer quotes
      const raw = line.slice(sub.length).trim();
      const text =
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
      return { action: "type", text };
    }

    case "open": {
      const app = parts.slice(1).join(" ");
      if (!app) return { action: "unknown", raw: line };
      return { action: "open", app };
    }

    case "windows":
      return { action: "windows" };

    default:
      return { action: "unknown", raw: line };
  }
}

// ---------------------------------------------------------------------------
// Desktop command handler — called from the interactive REPL
// ---------------------------------------------------------------------------

async function handleDesktopCommand(
  cmd: DesktopSubcommand,
  endpoint: string,
  apiKey: string,
  computerId: string,
  json: boolean,
): Promise<void> {
  switch (cmd.action) {
    case "screenshot": {
      const png = (await desktopRequest(
        endpoint,
        apiKey,
        computerId,
        "screenshot",
      )) as Buffer;
      const ts = Date.now();
      const outPath = join(tmpdir(), `miosa-screenshot-${ts}.png`);
      writeFileSync(outPath, png);
      if (json) {
        process.stdout.write(
          JSON.stringify({
            saved: outPath,
            bytes: png.length,
            timestamp: ts,
          }) + "\n",
        );
      } else {
        process.stdout.write(chalk.green(`Screenshot saved to ${outPath}\n`));
      }
      break;
    }

    case "click": {
      const result = await desktopRequest(
        endpoint,
        apiKey,
        computerId,
        "click",
        {
          x: cmd.x,
          y: cmd.y,
          button: cmd.button,
        },
      );
      if (json) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        process.stdout.write(
          chalk.green(`Clicked at (${cmd.x}, ${cmd.y}) [${cmd.button}]\n`),
        );
      }
      break;
    }

    case "type": {
      const result = await desktopRequest(
        endpoint,
        apiKey,
        computerId,
        "type",
        {
          text: cmd.text,
        },
      );
      if (json) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        process.stdout.write(chalk.green(`Typed: ${cmd.text}\n`));
      }
      break;
    }

    case "open": {
      const result = await desktopRequest(
        endpoint,
        apiKey,
        computerId,
        "launch",
        { app: cmd.app },
      );
      if (json) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        process.stdout.write(chalk.green(`Launched ${cmd.app}\n`));
      }
      break;
    }

    case "windows": {
      const result = await desktopRequest(
        endpoint,
        apiKey,
        computerId,
        "windows",
      );
      if (json) {
        process.stdout.write(JSON.stringify(result) + "\n");
      } else {
        // Pretty-print: result is likely an array of window objects
        if (Array.isArray(result)) {
          if (result.length === 0) {
            process.stdout.write(chalk.dim("No open windows.\n"));
          } else {
            for (const w of result as Array<Record<string, unknown>>) {
              const title = String(w["title"] ?? w["name"] ?? "(untitled)");
              const id = w["id"] !== undefined ? ` [${String(w["id"])}]` : "";
              process.stdout.write(`  ${title}${id}\n`);
            }
          }
        } else {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        }
      }
      break;
    }

    case "unknown":
      process.stdout.write(
        chalk.yellow(
          `Unknown desktop command: ${cmd.raw}\n` +
            `Available: screenshot | click X Y [button] | type "text" | open APP | windows\n`,
        ),
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Help text for the interactive session
// ---------------------------------------------------------------------------

function printSessionHelp(computerName: string): void {
  process.stdout.write(
    chalk.dim(
      `Connected to ${computerName}. Type commands normally. Special commands:\n` +
        `  desktop screenshot         - take screenshot (saved to /tmp/)\n` +
        `  desktop click X Y          - click at coordinates\n` +
        `  desktop click X Y right    - right-click at coordinates\n` +
        `  desktop type "text"        - type text on desktop\n` +
        `  desktop open APP           - launch an application\n` +
        `  desktop windows            - list open windows\n` +
        `  exit                       - disconnect\n\n`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Connection banner
// ---------------------------------------------------------------------------

function formatBanner(computer: ComputerSummary): string {
  const name = computer.name || computer.id;
  const image = computer.image ?? "unknown";
  const cpuCount = computer.cpu_count ?? computer.vcpu ?? computer.cpu ?? null;
  const ramMb = computer.ram_mb ?? computer.memory_mb ?? null;
  const ram =
    ramMb !== null ? `${Math.round((ramMb as number) / 1024)}GB RAM` : null;
  const cpu = cpuCount !== null ? `${cpuCount} CPU` : null;

  const specs = [cpu, ram].filter(Boolean).join(", ");
  const specStr = specs ? `, ${specs}` : "";

  return (
    chalk.bold.green(`Connected to ${name}`) +
    chalk.dim(` (${image}${specStr})`)
  );
}

// ---------------------------------------------------------------------------
// JSON mode (non-interactive) — run a single desktop or shell command
// ---------------------------------------------------------------------------

async function runJsonMode(opts: {
  computerId: string;
  desktopCmd?: string;
  shellCmd?: string;
  endpoint: string;
  apiKey: string;
}): Promise<void> {
  if (opts.desktopCmd) {
    const parsed = parseDesktopCommand(opts.desktopCmd);
    await handleDesktopCommand(
      parsed,
      opts.endpoint,
      opts.apiKey,
      opts.computerId,
      true,
    );
    return;
  }

  if (opts.shellCmd) {
    // Use computerExec SSE stream for non-interactive shell command
    const client = new MiosaClient(loadConfig());
    const res = await client.computerExec(
      opts.computerId as ComputerId,
      opts.shellCmd,
    );
    const { parseSse } = await import("../client.js");
    for await (const event of parseSse(res.body)) {
      switch (event.type) {
        case "stdout":
          process.stdout.write(event.data);
          break;
        case "stderr":
          process.stderr.write(event.data);
          break;
        case "exit":
          process.exit(event.exit_code);
          break;
        case "error":
          process.stderr.write(`Error: ${event.message}\n`);
          process.exit(1);
          break;
        default:
          break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Interactive shell session
// ---------------------------------------------------------------------------

async function runInteractiveSession(opts: {
  computer: ComputerSummary;
  ticket: PtyTicket;
  endpoint: string;
  apiKey: string;
}): Promise<number> {
  const { computer, ticket, endpoint, apiKey } = opts;
  const computerId = computer.id as string;
  const computerName = computer.name || computerId;

  return new Promise<number>((resolve) => {
    const ws = new WebSocket(ticket.ws_url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // Track whether we're in the middle of a desktop call so we can suppress
    // echoing that line to the PTY.
    let pendingDesktop = false;

    // Buffer for intercepting typed lines — we use readline in "line mode" but
    // the PTY expects raw chars. We switch strategy based on whether the user
    // is typing a desktop command (line-buffered check) vs normal (raw).
    let lineBuffer = "";
    let inDesktopCapture = false;

    let cleanedUp = false;

    function cleanup(code: number): void {
      if (cleanedUp) return;
      cleanedUp = true;

      // Restore terminal
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.stdin.removeAllListeners("data");
      process.removeAllListeners("SIGWINCH");

      if (ws.readyState === WebSocket.OPEN) ws.close();
      resolve(code);
    }

    function sendResize(): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      const { cols, rows } = getTerminalSize();
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }

    ws.on("open", () => {
      // Put terminal in raw mode so the PTY gets key-by-key input
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      sendResize();

      // Print the connection banner after the WS is open
      process.stdout.write(formatBanner(computer) + "\n");
      printSessionHelp(computerName);

      process.on("SIGWINCH", sendResize);

      // stdin data handler — intercept "desktop " lines; forward everything
      // else raw to the PTY.
      process.stdin.on("data", (chunk: Buffer) => {
        const str = chunk.toString("utf8");

        for (const char of str) {
          const code = char.charCodeAt(0);

          // Ctrl+C (0x03) — forward to PTY (interrupt running process), do NOT exit CLI
          if (code === 0x03) {
            if (!pendingDesktop && ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
            return;
          }

          // Ctrl+D (0x04) — disconnect
          if (code === 0x04) {
            cleanup(0);
            return;
          }

          // Accumulate characters to detect "desktop " prefix
          if (inDesktopCapture) {
            if (char === "\r" || char === "\n") {
              // End of desktop command line — process it
              const captured = lineBuffer;
              lineBuffer = "";
              inDesktopCapture = false;
              pendingDesktop = true;

              // Echo a newline back to user (raw mode won't auto-echo)
              process.stdout.write("\r\n");

              const parsed = parseDesktopCommand(captured);
              void handleDesktopCommand(
                parsed,
                endpoint,
                apiKey,
                computerId,
                false,
              ).finally(() => {
                pendingDesktop = false;
                // Re-emit the shell prompt hint
                process.stdout.write(chalk.dim(`${computerName}> `));
              });
              return;
            }

            if (char === "\x7f" || char === "\x08") {
              // Backspace
              if (lineBuffer.length > 0) {
                lineBuffer = lineBuffer.slice(0, -1);
                // Check if we've deleted back past "desktop "
                if (
                  !lineBuffer.startsWith("desktop ") &&
                  lineBuffer !== "desktop"
                ) {
                  inDesktopCapture = false;
                  // Forward the accumulated buffer so far to the PTY
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(Buffer.from("desktop " + lineBuffer + "\x08"));
                  }
                  lineBuffer = "";
                } else {
                  process.stdout.write("\x08 \x08");
                }
              }
              return;
            }

            // Regular character — accumulate and echo
            lineBuffer += char;
            process.stdout.write(char);
            return;
          }

          // Not in desktop capture yet — check if this starts a desktop command
          lineBuffer += char;

          if (
            "desktop ".startsWith(lineBuffer) &&
            lineBuffer.length <= "desktop ".length
          ) {
            // Could be the start of a desktop command — keep buffering silently
            // but echo to user so they see what they type
            process.stdout.write(char);

            if (lineBuffer === "desktop ") {
              inDesktopCapture = true;
              // Keep lineBuffer empty for the subcommand part
              lineBuffer = "";
            }
            return;
          }

          // Not a desktop command — flush buffer + current char to PTY
          if (lineBuffer.length > 0) {
            const flush = lineBuffer; // includes current char
            lineBuffer = "";
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(Buffer.from(flush));
            }
          }
        }
      });
    });

    // PTY output → local stdout
    ws.on("message", (data: Buffer | string) => {
      if (!pendingDesktop) {
        process.stdout.write(typeof data === "string" ? data : data);
      }
    });

    ws.on("close", (code) => {
      cleanup(code === 1000 ? 0 : 1);
    });

    ws.on("error", (err) => {
      process.stderr.write(`\r\nWebSocket error: ${err.message}\r\n`);
      cleanup(2);
    });

    process.stdin.on("end", () => {
      ws.close();
    });
  });
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command("shell <computer-id>")
    .description(
      "Open an interactive shell + desktop control session on a Computer (SSH and desktop in one)",
    )
    .option("--json", "Non-interactive mode — print structured JSON output")
    .option(
      "--desktop <cmd>",
      'Run a single desktop command (e.g. "screenshot")',
    )
    .option("--cmd <command>", "Run a single shell command and exit")
    .action(
      async (
        computerIdArg: string,
        opts: { json?: boolean; desktop?: string; cmd?: string },
      ) => {
        try {
          const config = loadConfig();
          if (!config.api_key) {
            process.stderr.write(
              chalk.red("You are not logged in. Run: miosa login\n"),
            );
            process.exit(3);
          }

          const endpoint = config.endpoint.replace(/\/$/, "");
          const apiKey = config.api_key;

          const client = new MiosaClient(config);
          const resolvedComputer = await resolveComputer(client, computerIdArg);
          const computerId = resolvedComputer?.id ?? computerIdArg;

          // --- Non-interactive JSON / single-command mode ---
          if (opts.json || opts.desktop || opts.cmd) {
            await runJsonMode({
              computerId,
              desktopCmd: opts.desktop,
              shellCmd: opts.cmd,
              endpoint,
              apiKey,
            });
            return;
          }

          // --- Interactive mode ---
          const spinner = spin(`Connecting to ${computerIdArg}...`);

          // Fetch computer details for the banner (best-effort — don't block on 404)
          let computer: ComputerSummary;
          if (resolvedComputer) {
            computer = resolvedComputer;
          } else {
            try {
              computer = await client
                .apiGet<{
                  data: ComputerSummary;
                }>(`/api/v1/computers/${encodeURIComponent(computerId)}`)
                .then((r) => r.data ?? (r as unknown as ComputerSummary));
            } catch {
              // Fall back to a minimal stub so we can still connect
              computer = {
                id: computerId as ComputerId,
                name: computerIdArg,
                state: "unknown",
              };
            }
          }

          if (computer.state !== "running" && computer.state !== "unknown") {
            spinner.warn(
              `Computer "${computer.name || computerIdArg}" is ${computer.state}. Connection may fail.`,
            );
          } else {
            spinner.text = `Opening PTY on ${computer.name || computerIdArg}...`;
          }

          const ticket = await createPty(endpoint, apiKey, computerId);
          spinner.stop();

          const exitCode = await runInteractiveSession({
            computer,
            ticket,
            endpoint,
            apiKey,
          });

          process.exit(exitCode);
        } catch (err) {
          handleError(err);
        }
      },
    );
}
