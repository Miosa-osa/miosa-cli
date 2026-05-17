/**
 * miosa agent — first-class CUA (Computer Use Agent) session management.
 *
 * Routes map to: /api/v1/computers/:computer_id/cua/sessions[/:session_id/...]
 *
 * Subcommands:
 *   start     POST   /computers/:id/cua/sessions
 *   ls        GET    /computers/:id/cua/sessions  (all computers when no --computer)
 *   get       GET    /computers/:id/cua/sessions/:session_id
 *   task      POST   /computers/:id/cua/sessions/:session_id/task
 *   pause     POST   /computers/:id/cua/sessions/:session_id/pause
 *   resume    POST   /computers/:id/cua/sessions/:session_id/resume
 *   stop      DELETE /computers/:id/cua/sessions/:session_id
 *   history   GET    /computers/:id/cua/sessions/:session_id/events
 */

import type { Command } from "commander";
import chalk from "chalk";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

// ---------------------------------------------------------------------------
// Domain types — match backend CUA session shape
// ---------------------------------------------------------------------------

interface AgentSession {
  id: string;
  computer_id: string;
  computer_name?: string | null;
  status: string;
  goal: string;
  model_id?: string | null;
  max_turns?: number | null;
  actions_total?: number | null;
  actions_exec?: number | null;
  actions_click?: number | null;
  actions_type?: number | null;
  screenshots?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  inserted_at?: string | null;
  updated_at?: string | null;
}

interface AgentSessionEvent {
  id?: string | null;
  type: string;
  content?: string | null;
  timestamp?: string | null;
  inserted_at?: string | null;
}

interface ComputerListItem {
  id: string;
  name: string;
  status?: string | null;
  state?: string | null;
}

type JsonOptions = { json?: boolean };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiV1(path: string): string {
  return `/api/v1${path}`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Extract a list from the standard {data: [...]} envelope or bare array. */
function listOf<T>(payload: unknown, extraKeys: string[] = []): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (isRecord(payload)) {
    if (Array.isArray(payload["data"])) return payload["data"] as T[];
    for (const key of extraKeys) {
      if (Array.isArray(payload[key])) return payload[key] as T[];
    }
  }
  return [];
}

/** Extract a single object from {data: {...}} envelope or the payload itself. */
function dataOf<T>(payload: unknown): T {
  if (isRecord(payload) && isRecord(payload["data"])) {
    return payload["data"] as T;
  }
  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve a computer by name or ID.
 * Calls GET /api/v1/computers and filters the list.
 */
async function resolveComputer(
  c: MiosaClient,
  nameOrId: string,
): Promise<ComputerListItem> {
  const payload = await c.apiGet<unknown>(apiV1("/computers"));
  const items = listOf<ComputerListItem>(payload, ["computers"]);
  const match = items.find(
    (item) => item.id === nameOrId || item.name === nameOrId,
  );
  if (!match) {
    throw new UserError(
      `Computer not found: ${nameOrId}`,
      "Run `miosa computers list` to see available computers.",
    );
  }
  return match;
}

/** Relative time string, e.g. "3 minutes ago" */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return chalk.dim("—");
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours ago`;
  return `${Math.floor(ms / 86_400_000)} days ago`;
}

/** "3m 42s" from two ISO timestamps */
function duration(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start) return chalk.dim("—");
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = endMs - new Date(start).getTime();
  if (ms < 0) return chalk.dim("—");
  const totalSec = Math.floor(ms / 1_000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

/** Truncate a string to max characters, appending "…" if cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function colorStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "running":
      return chalk.green(status);
    case "paused":
      return chalk.yellow(status);
    case "completed":
    case "done":
      return chalk.dim(status);
    case "failed":
    case "cancelled":
      return chalk.red(status);
    default:
      return chalk.dim(status);
  }
}

function colorEventType(type: string): string {
  switch (type.toLowerCase()) {
    case "thought":
      return chalk.magenta(type.padEnd(8));
    case "exec":
      return chalk.blue(type.padEnd(8));
    case "click":
      return chalk.cyan(type.padEnd(8));
    case "type":
      return chalk.cyan(type.padEnd(8));
    case "done":
      return chalk.green(type.padEnd(8));
    case "error":
      return chalk.red(type.padEnd(8));
    default:
      return chalk.dim(type.padEnd(8));
  }
}

function formatEventTimestamp(
  event: AgentSessionEvent,
  baseTime: Date,
): string {
  const raw = event.timestamp ?? event.inserted_at;
  if (!raw) return chalk.dim("--:--:--");
  const d = new Date(raw);
  // Offset from session start for context
  const diffMs = d.getTime() - baseTime.getTime();
  const absTime = d.toLocaleTimeString("en-US", { hour12: false });
  if (diffMs < 0) return chalk.dim(absTime);
  return chalk.dim(absTime);
}

// ---------------------------------------------------------------------------
// Subcommand builders
// ---------------------------------------------------------------------------

function buildStart(agent: Command): void {
  agent
    .command("start")
    .description("Start an agent session on a computer")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .requiredOption("--goal <goal>", "Goal for the agent to accomplish")
    .option("--model <model-id>", "Model ID override")
    .option("--max-turns <n>", "Maximum agent turns (default: server default)")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        computer: string;
        goal: string;
        model?: string;
        maxTurns?: string;
        json?: boolean;
      }) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const spinner = spin(`Resolving computer ${opts.computer}…`);
          const computer = await resolveComputer(c, opts.computer);
          spinner.succeed(`Starting agent on ${computer.name}`);

          const body: Record<string, unknown> = { goal: opts.goal };
          if (opts.model) body["model_id"] = opts.model;
          if (opts.maxTurns != null)
            body["max_turns"] = parseInt(opts.maxTurns, 10);

          const payload = await c.apiPost<unknown>(
            apiV1(`/computers/${enc(computer.id)}/cua/sessions`),
            body,
          );

          const session = dataOf<AgentSession>(payload);

          if (opts.json) {
            console.log(JSON.stringify(session, null, 2));
            return;
          }

          console.log(chalk.green(`Agent session started: ${session.id}`));
          console.log(
            chalk.dim(
              `Watch: miosa agent get ${session.id} --computer ${computer.name}`,
            ),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildLs(agent: Command): void {
  agent
    .command("ls")
    .description(
      "List active agent sessions (all computers or one with --computer)",
    )
    .option("--computer <name-or-id>", "Filter to a specific computer")
    .option("--json", "Output as JSON")
    .action(async (opts: { computer?: string; json?: boolean }) => {
      try {
        const config = loadConfig();
        const c = new MiosaClient(config);

        let sessions: AgentSession[];

        if (opts.computer) {
          const spinner = spin(`Fetching sessions for ${opts.computer}…`);
          const computer = await resolveComputer(c, opts.computer);
          spinner.text = `Loading sessions on ${computer.name}…`;
          const payload = await c.apiGet<unknown>(
            apiV1(`/computers/${enc(computer.id)}/cua/sessions`),
          );
          sessions = listOf<AgentSession>(payload, ["sessions"]).map((s) => ({
            ...s,
            computer_name: computer.name,
          }));
          spinner.stop();
        } else {
          const spinner = spin("Fetching all computers…");
          const computersPayload = await c.apiGet<unknown>(apiV1("/computers"));
          const computers = listOf<ComputerListItem>(computersPayload, [
            "computers",
          ]);
          spinner.text = `Fetching sessions across ${computers.length} computer(s)…`;

          const settled = await Promise.allSettled(
            computers.map(async (computer) => {
              const payload = await c.apiGet<unknown>(
                apiV1(`/computers/${enc(computer.id)}/cua/sessions`),
              );
              return listOf<AgentSession>(payload, ["sessions"]).map((s) => ({
                ...s,
                computer_name: computer.name,
              }));
            }),
          );

          sessions = settled.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          );
          spinner.stop();
        }

        if (opts.json) {
          console.log(JSON.stringify(sessions, null, 2));
          return;
        }

        if (sessions.length === 0) {
          console.log(chalk.dim("No agent sessions found."));
          return;
        }

        renderTable<AgentSession>(sessions, [
          {
            header: "ID",
            key: (s) => s.id,
            width: 22,
          },
          {
            header: "COMPUTER",
            key: (s) => s.computer_name ?? s.computer_id,
            width: 16,
          },
          {
            header: "STATUS",
            key: (s) => s.status,
            width: 10,
            color: (val) => colorStatus(val.trim()),
          },
          {
            header: "STARTED",
            key: (s) => timeAgo(s.started_at ?? s.inserted_at),
            width: 18,
          },
          {
            header: "GOAL",
            key: (s) => truncate(s.goal, 42),
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });
}

function buildGet(agent: Command): void {
  agent
    .command("get <session-id>")
    .description("Get details of an agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--json", "Output as JSON")
    .action(
      async (sessionId: string, opts: { computer: string; json?: boolean }) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const payload = await c.apiGet<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}`,
            ),
          );
          const session = dataOf<AgentSession>(payload);

          if (opts.json) {
            console.log(JSON.stringify(session, null, 2));
            return;
          }

          const rows: Array<[string, string]> = [
            ["Session", session.id],
            ["Computer", session.computer_name ?? computer.name],
            ["Status", colorStatus(session.status)],
            ["Started", session.started_at ?? chalk.dim("—")],
            ["Goal", session.goal],
          ];

          if (session.actions_total != null) {
            const parts: string[] = [`${session.actions_total} total`];
            if (session.actions_exec != null)
              parts.push(`${session.actions_exec} exec`);
            if (session.actions_click != null)
              parts.push(`${session.actions_click} click`);
            if (session.actions_type != null)
              parts.push(`${session.actions_type} type`);
            rows.push(["Actions", parts.join(", ")]);
          }

          if (session.screenshots != null) {
            rows.push(["Screenshots", String(session.screenshots)]);
          }

          rows.push([
            "Duration",
            duration(session.started_at, session.finished_at),
          ]);

          if (session.model_id) {
            rows.push(["Model", session.model_id]);
          }

          for (const [label, value] of rows) {
            console.log(`${chalk.bold(label.padEnd(14))} ${value}`);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildTask(agent: Command): void {
  agent
    .command("task <session-id> <instruction>")
    .description("Send a new task to a running agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--json", "Output as JSON")
    .action(
      async (
        sessionId: string,
        instruction: string,
        opts: { computer: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const payload = await c.apiPost<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}/task`,
            ),
            { instruction },
          );

          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }

          console.log(chalk.green(`Task submitted to ${sessionId}`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildPause(agent: Command): void {
  agent
    .command("pause <session-id>")
    .description("Pause a running agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--json", "Output as JSON")
    .action(
      async (sessionId: string, opts: { computer: string; json?: boolean }) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const payload = await c.apiPost<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}/pause`,
            ),
            {},
          );

          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }

          console.log(chalk.yellow(`Session ${sessionId} paused.`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildResume(agent: Command): void {
  agent
    .command("resume <session-id>")
    .description("Resume a paused agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--json", "Output as JSON")
    .action(
      async (sessionId: string, opts: { computer: string; json?: boolean }) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const payload = await c.apiPost<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}/resume`,
            ),
            {},
          );

          if (opts.json) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }

          console.log(chalk.green(`Session ${sessionId} resumed.`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildStop(agent: Command): void {
  agent
    .command("stop <session-id>")
    .description("Stop (cancel) an agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--json", "Output as JSON")
    .action(
      async (sessionId: string, opts: { computer: string; json?: boolean }) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const payload = await c.apiDelete<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}`,
            ),
          );

          if (opts.json) {
            console.log(JSON.stringify(payload ?? { stopped: true }, null, 2));
            return;
          }

          console.log(chalk.green("Agent session stopped."));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function buildHistory(agent: Command): void {
  agent
    .command("history <session-id>")
    .description("View the event history of an agent session")
    .requiredOption("--computer <name-or-id>", "Computer name or ID")
    .option("--limit <n>", "Maximum number of events to show")
    .option("--json", "Output as JSON")
    .action(
      async (
        sessionId: string,
        opts: { computer: string; limit?: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const c = new MiosaClient(config);

          const computer = await resolveComputer(c, opts.computer);

          const qs = opts.limit ? `?limit=${enc(opts.limit)}` : "";
          const payload = await c.apiGet<unknown>(
            apiV1(
              `/computers/${enc(computer.id)}/cua/sessions/${enc(sessionId)}/events${qs}`,
            ),
          );

          const events = listOf<AgentSessionEvent>(payload, ["events"]);

          if (opts.json) {
            console.log(JSON.stringify(events, null, 2));
            return;
          }

          if (events.length === 0) {
            console.log(chalk.dim("No events recorded yet."));
            return;
          }

          // Determine base time for relative display from first event
          const firstTimestamp = events[0]?.timestamp ?? events[0]?.inserted_at;
          const baseTime = firstTimestamp
            ? new Date(firstTimestamp)
            : new Date();

          for (const event of events) {
            const ts = formatEventTimestamp(event, baseTime);
            const typePart = colorEventType(event.type);
            const contentPart = event.content
              ? truncate(event.content, 100)
              : chalk.dim("—");
            console.log(`${ts} [${typePart}]  ${contentPart}`);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const agent = program
    .command("agent")
    .description(
      "Manage AI agent (CUA) sessions on Computers — start, monitor, and control agent runs",
    );

  buildStart(agent);
  buildLs(agent);
  buildGet(agent);
  buildTask(agent);
  buildPause(agent);
  buildResume(agent);
  buildStop(agent);
  buildHistory(agent);
}
