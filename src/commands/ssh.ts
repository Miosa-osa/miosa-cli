import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { runWsPty } from "../pty/ws-pty-client.js";
import { spin } from "../ui/spinner.js";
import type { ComputerId } from "../types.js";

interface ComputerSummary {
  id: ComputerId;
  name?: string | null;
  state?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

interface PtyTicket {
  id: string;
  ws_url: string;
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

async function createComputerPty(
  client: MiosaClient,
  computerId: string,
): Promise<PtyTicket> {
  const payload = await client.apiPost<unknown>(
    `/api/v1/computers/${encodeURIComponent(computerId)}/terminal`,
    {
      cmd: "/bin/bash",
      env: { TERM: "xterm-256color" },
    },
  );
  return dataOf<PtyTicket>(payload);
}

export function register(program: Command): void {
  program
    .command("ssh <computer>")
    .description(
      "Open an interactive terminal session on a Computer (falls back to OpenComputers hosts)",
    )
    .option("--cmd <command>", "Run a single command and exit (best-effort)")
    .action(async (computerArg: string, opts: { cmd?: string }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const spinner = spin(`Connecting to ${computerArg}...`);
        const computer = await resolveComputer(client, computerArg);

        if (computer) {
          const status = String(
            computer.status ?? computer.state ?? "unknown",
          ).toLowerCase();
          const label = computer.name || computer.id;

          if (status !== "running" && status !== "unknown") {
            spinner.warn(
              `Computer "${label}" is ${status}. Connection may fail.`,
            );
          } else {
            spinner.text = `Opening terminal on ${label}...`;
          }

          const ticket = await createComputerPty(client, computer.id);
          spinner.stop();

          const exitCode = await runWsPty({
            url: ticket.ws_url,
            token: config.api_key ?? undefined,
            oneShot: opts.cmd,
          });

          process.exit(exitCode);
          return;
        }

        spinner.text = `Resolving OpenComputers host ${computerArg}...`;
        const host = await client.getHost(computerArg);

        if (host.state !== "online") {
          spinner.warn(
            `Host "${host.name}" is ${host.state}. Connection may fail.`,
          );
        } else {
          spinner.stop();
        }

        const ticket = await client.getTerminalTicket(host.id);
        spinner.stop();

        const exitCode = await runWsPty({
          url: ticket.url,
          token: ticket.token,
          oneShot: opts.cmd,
        });

        process.exit(exitCode);
      } catch (err) {
        handleError(err);
      }
    });
}
