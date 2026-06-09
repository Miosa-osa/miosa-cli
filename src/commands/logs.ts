import type { Command } from "commander";
import chalk from "chalk";
import React from "react";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { UserError } from "../errors.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import { errorEnvelope } from "../ui/render.js";
import type { Deployment } from "../types.js";
import { isJsonMode } from "../cli-env.js";

// ── Resource type detection ───────────────────────────────────────────────────

type ResourceKind = "deployment" | "computer" | "sandbox";

interface ResourceHint {
  kind: ResourceKind;
  id: string;
}

interface LogLine {
  line: string;
  timestamp?: string;
  stream?: string;
  raw?: unknown;
}

interface LogFilterOptions {
  lines?: number;
  tail?: number;
  startTime?: string;
  contains?: string;
  textIncludes?: string;
  textNotIncludes?: string;
  regex?: string;
  regexIncludes?: string;
  regexNotIncludes?: string;
}

/**
 * Auto-detect whether a resource ID belongs to a deployment, computer, or sandbox
 * by probing each API in order of likelihood. Falls back to deployment logs.
 */
async function detectResource(
  client: MiosaClient,
  resourceId: string,
): Promise<ResourceHint> {
  // Try deployment first (most common for `miosa logs`)
  try {
    await client.getDeployment(resourceId as Deployment["id"]);
    return { kind: "deployment", id: resourceId };
  } catch {
    // not a deployment
  }

  // Try computer
  try {
    await client.apiGet<unknown>(
      `/api/v1/computers/${encodeURIComponent(resourceId)}`,
    );
    return { kind: "computer", id: resourceId };
  } catch {
    // not a computer
  }

  // Try sandbox
  try {
    await client.apiGet<unknown>(
      `/api/v1/sandboxes/${encodeURIComponent(resourceId)}`,
    );
    return { kind: "sandbox", id: resourceId };
  } catch {
    // not a sandbox
  }

  throw new UserError(
    `Resource not found: ${resourceId}`,
    "Pass a deployment name/ID, computer ID, or sandbox ID.",
  );
}

async function resolveAppId(
  client: MiosaClient,
  appArg: string | undefined,
): Promise<Deployment["id"]> {
  if (!appArg) return resolveDeploymentId();

  try {
    return (await client.getDeployment(appArg as Deployment["id"])).id;
  } catch {
    const app = (await client.listDeployments()).find(
      (candidate) =>
        candidate.id === appArg ||
        candidate.name === appArg ||
        candidate.slug === appArg,
    );
    if (!app) throw new UserError(`App not found: ${appArg}`);
    return app.id;
  }
}

function printMachineLogs(
  payload: unknown,
  json: boolean,
  filters: LogFilterOptions = {},
): void {
  if (hasLogFilters(filters)) {
    const logs = filterLogLines(extractLogLines(payload), filters);
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            count: logs.length,
            logs: logs.map((entry) => ({
              line: entry.line,
              timestamp: entry.timestamp,
              stream: entry.stream,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    for (const entry of logs) {
      const prefix = entry.timestamp ? `${chalk.dim(entry.timestamp)} ` : "";
      console.log(`${prefix}${entry.line}`);
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (Array.isArray(payload)) {
    for (const row of payload) console.log(JSON.stringify(row));
    return;
  }
  if (payload && typeof payload === "object" && "data" in payload) {
    printMachineLogs((payload as { data: unknown }).data, json);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function printDeploymentLogsJson(
  client: MiosaClient,
  deploymentId: string,
  filters: LogFilterOptions = {},
): Promise<void> {
  const payload = await client.apiGet<unknown>(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}/logs`,
  );
  printMachineLogs(payload, true, filters);
}

async function streamSse(
  res: Awaited<ReturnType<MiosaClient["streamDeploymentLogs"]>>,
  filters: LogFilterOptions = {},
): Promise<void> {
  for await (const event of parseSse(res.body)) {
    switch (event.type) {
      case "stdout":
        writeFilteredLogChunk(process.stdout, event.data, filters);
        break;
      case "stderr":
        writeFilteredLogChunk(process.stderr, event.data, filters, true);
        break;
      case "error":
        console.error(chalk.red(event.message));
        break;
      case "done":
        return;
      case "unknown":
        try {
          const parsed = JSON.parse(event.raw) as Record<string, unknown>;
          if (typeof parsed["line"] === "string") {
            const line = parsed["line"];
            if (parsed["stream"] === "stderr") {
              writeFilteredLogChunk(process.stderr, line + "\n", filters, true);
            } else {
              writeFilteredLogChunk(process.stdout, line + "\n", filters);
            }
          }
        } catch {
          // Ignore malformed stream frames.
        }
        break;
      default:
        break;
    }
  }
}

function hasLogFilters(filters: LogFilterOptions): boolean {
  return Boolean(
    filters.lines != null ||
      filters.tail != null ||
      filters.startTime ||
      filters.contains ||
      filters.textIncludes ||
      filters.textNotIncludes ||
      filters.regex ||
      filters.regexIncludes ||
      filters.regexNotIncludes,
  );
}

function extractLogLines(payload: unknown): LogLine[] {
  if (payload == null) return [];
  if (typeof payload === "string") {
    return payload
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => ({ line }));
  }
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => extractLogLines(item));
  }
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["data", "logs", "lines", "items", "events"]) {
      if (Array.isArray(obj[key]) || typeof obj[key] === "string") {
        return extractLogLines(obj[key]);
      }
    }

    const lineValue =
      obj["line"] ?? obj["log"] ?? obj["message"] ?? obj["text"] ?? obj["stdout"];
    const stderrValue = obj["stderr"];
    if (typeof lineValue === "string") {
      return splitLogText(lineValue, {
        timestamp: stringish(obj["timestamp"] ?? obj["ts"] ?? obj["time"] ?? obj["t"]),
        stream: stringish(obj["stream"]),
        raw: payload,
      });
    }
    if (typeof stderrValue === "string") {
      return splitLogText(stderrValue, {
        timestamp: stringish(obj["timestamp"] ?? obj["ts"] ?? obj["time"] ?? obj["t"]),
        stream: "stderr",
        raw: payload,
      });
    }
    return [{ line: JSON.stringify(payload), raw: payload }];
  }
  return [{ line: String(payload), raw: payload }];
}

function splitLogText(
  text: string,
  meta: Omit<LogLine, "line"> = {},
): LogLine[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => ({ ...meta, line }));
}

function stringish(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(value);
}

function filterLogLines(lines: LogLine[], filters: LogFilterOptions): LogLine[] {
  const includes = filters.contains ?? filters.textIncludes;
  const regexIncludes = filters.regex ?? filters.regexIncludes;
  const includeRe = regexIncludes ? new RegExp(regexIncludes) : null;
  const excludeRe = filters.regexNotIncludes
    ? new RegExp(filters.regexNotIncludes)
    : null;
  const startMs = filters.startTime ? Date.parse(filters.startTime) : NaN;
  let out = lines.filter((entry) => {
    if (Number.isFinite(startMs) && entry.timestamp) {
      const entryMs = Date.parse(entry.timestamp);
      if (Number.isFinite(entryMs) && entryMs < startMs) return false;
    }
    if (includes && !entry.line.includes(includes)) return false;
    if (filters.textNotIncludes && entry.line.includes(filters.textNotIncludes)) {
      return false;
    }
    if (includeRe && !includeRe.test(entry.line)) return false;
    if (excludeRe && excludeRe.test(entry.line)) return false;
    return true;
  });
  const limit = filters.tail ?? filters.lines;
  if (limit != null && limit >= 0) {
    out = out.slice(-limit);
  }
  return out;
}

function writeFilteredLogChunk(
  stream: NodeJS.WriteStream,
  data: string,
  filters: LogFilterOptions,
  red = false,
): void {
  if (!hasLogFilters(filters)) {
    stream.write(red ? chalk.red(data) : data);
    return;
  }
  const lines = filterLogLines(splitLogText(data), filters);
  for (const entry of lines) {
    stream.write((red ? chalk.red(entry.line) : entry.line) + "\n");
  }
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("logs [resource-id]")
    .description(
      "Stream logs — auto-detects computer, deployment, or sandbox by ID",
    )
    .option("--machine <id>", "Explicitly fetch logs for a computer/machine")
    .option("--sandbox <id>", "Explicitly fetch logs for a sandbox")
    .option("--deployment <id>", "Explicitly fetch logs for a deployment/app")
    .option("-l, --lines <n>", "Limit one-shot output to the last N lines", parsePositiveInt)
    .option("--tail <n>", "Alias for --lines", parsePositiveInt)
    .option("--start-time <timestamp>", "Only include log lines at or after this timestamp")
    .option("--contains <text>", "Only include log lines containing this text")
    .option("--text-includes <text>", "Alias for --contains")
    .option("--text-not-includes <text>", "Exclude log lines containing this text")
    .option("--regex <pattern>", "Only include log lines matching this regex")
    .option("--regex-includes <pattern>", "Alias for --regex")
    .option("--regex-not-includes <pattern>", "Exclude log lines matching this regex")
    .option("--json", "Output raw JSON")
    .option("-f, --follow", "Open live TUI log tail (requires a TTY)")
    .addHelpText(
      "after",
      `
Examples:
  miosa logs                          Stream logs for linked deployment
  miosa logs <deployment-id>          Stream deployment logs
  miosa logs <computer-id>            Stream computer logs (auto-detected)
  miosa logs <sandbox-id>             Stream sandbox logs (auto-detected)
  miosa logs --machine <id>           Explicit computer logs
  miosa logs --sandbox <id>           Explicit sandbox logs
  miosa logs --deployment <id>        Explicit deployment logs
  miosa logs <id> --lines 100         Print recent log lines
  miosa logs <id> --contains error    Filter log lines by text
  miosa logs <id> --regex "500|panic" Filter log lines by regex
  miosa logs <id> --follow            Live TUI tail (interactive)
  miosa logs <id> -f                  Same as --follow
`,
    )
    .action(
      async (
        resourceId: string | undefined,
        opts: {
          machine?: string;
          sandbox?: string;
          deployment?: string;
          json?: boolean;
          follow?: boolean;
        } & LogFilterOptions,
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const filters: LogFilterOptions = opts;

          // ── --follow: mount ink TUI ───────────────────────────────────────
          if (opts.follow && !hasLogFilters(filters)) {
            if (!process.stdout.isTTY) {
              console.log();
              console.log(
                errorEnvelope({
                  title: "TTY required for --follow",
                  body: "The live log tail renders interactively and cannot be piped.",
                  suggest: ["miosa logs <id>  # one-shot dump, scriptable"],
                }),
              );
              process.exit(2);
            }

            // Resolve the resource kind the same way the one-shot path does.
            let followId = resourceId ?? opts.machine ?? opts.sandbox;
            let followKind: "computer" | "sandbox" | "deployment" | "database" =
              "deployment";

            if (opts.machine) {
              followId = opts.machine;
              followKind = "computer";
            } else if (opts.sandbox) {
              followId = opts.sandbox;
              followKind = "sandbox";
            } else if (resourceId) {
              const hint = await detectResource(client, resourceId);
              followId = hint.id;
              followKind =
                hint.kind === "computer" || hint.kind === "sandbox"
                  ? hint.kind
                  : "deployment";
            } else {
              followId = await resolveAppId(client, undefined);
              followKind = "deployment";
            }

            // Dynamic import keeps cold-start cost off non-TUI invocations.
            const { render } = await import("ink");
            const { LogsTUI } = await import("../tui/logs.js");

            const { waitUntilExit } = render(
              React.createElement(LogsTUI, {
                resourceId: followId as string,
                resourceKind: followKind,
                config,
              }),
            );
            try {
              await waitUntilExit();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(chalk.red(`logs TUI crashed: ${msg}`));
              process.exit(1);
            }
            return;
          }

          if (opts.deployment) {
            if (isJsonMode(opts)) {
              await printDeploymentLogsJson(client, opts.deployment, filters);
              return;
            }
            console.log(
              chalk.dim(`Streaming deployment logs for ${opts.deployment}...`),
            );
            const res = await client.streamDeploymentLogs(
              opts.deployment as Deployment["id"],
            );
            await streamSse(res, filters);
            return;
          }

          // ── Explicit computer flag ────────────────────────────────────────
          if (opts.machine) {
            const payload = await client.apiGet<unknown>(
              `/api/v1/computers/${encodeURIComponent(opts.machine)}/logs`,
            );
            printMachineLogs(payload, isJsonMode(opts), filters);
            return;
          }

          // ── Explicit sandbox flag ─────────────────────────────────────────
          if (opts.sandbox) {
            const payload = await client.apiGet<unknown>(
              `/api/v1/sandboxes/${encodeURIComponent(opts.sandbox)}/logs`,
            );
            printMachineLogs(payload, isJsonMode(opts), filters);
            return;
          }

          // ── Auto-detect resource kind ─────────────────────────────────────
          if (resourceId) {
            const hint = await detectResource(client, resourceId);

            switch (hint.kind) {
              case "computer": {
                if (!isJsonMode(opts)) {
                  console.log(
                    chalk.dim(`Fetching computer logs for ${hint.id}...`),
                  );
                }
                const payload = await client.apiGet<unknown>(
                  `/api/v1/computers/${encodeURIComponent(hint.id)}/logs`,
                );
                printMachineLogs(payload, isJsonMode(opts), filters);
                return;
              }
              case "sandbox": {
                if (!isJsonMode(opts)) {
                  console.log(
                    chalk.dim(`Fetching sandbox logs for ${hint.id}...`),
                  );
                }
                const payload = await client.apiGet<unknown>(
                  `/api/v1/sandboxes/${encodeURIComponent(hint.id)}/logs`,
                );
                printMachineLogs(payload, isJsonMode(opts), filters);
                return;
              }
              case "deployment": {
                if (isJsonMode(opts)) {
                  await printDeploymentLogsJson(client, hint.id, filters);
                  return;
                }
                console.log(
                  chalk.dim(`Streaming deployment logs for ${hint.id}...`),
                );
                const res = await client.streamDeploymentLogs(
                  hint.id as Deployment["id"],
                );
                await streamSse(res, filters);
                return;
              }
            }
          }

          // ── No ID — fall back to .miosa.json linked deployment ────────────
          const deploymentId = await resolveAppId(client, undefined);
          if (isJsonMode(opts)) {
            await printDeploymentLogsJson(client, deploymentId, filters);
            return;
          }
          console.log(chalk.dim(`Streaming logs for ${deploymentId}...`));
          const res = await client.streamDeploymentLogs(deploymentId);
          await streamSse(res, filters);
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UserError(`Invalid integer: ${value}`);
  }
  return parsed;
}
