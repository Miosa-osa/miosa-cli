import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError, parseEnvPairs, parseDuration } from "./util.js";
import { spin } from "../ui/spinner.js";
import type { ComputerId } from "../types.js";

interface ComputerSummary {
  id: ComputerId;
  name?: string | null;
  status?: string | null;
  state?: string | null;
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
    return (
      listOf<ComputerSummary>(payload).find(
        (computer) =>
          computer.id === nameOrId || computer.name === nameOrId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

function computerCommand(cmd: string, args: string[]): string {
  if (args.length === 0) return cmd;
  const quote = (value: string): string =>
    /^[A-Za-z0-9_./:=@%+,-]+$/.test(value)
      ? value
      : `'${value.replaceAll("'", "'\\''")}'`;
  return [cmd, ...args.map(quote)].join(" ");
}

async function printStream(
  res: Awaited<ReturnType<MiosaClient["streamJob"]>>,
): Promise<number> {
  let exitCode = 0;

  for await (const event of parseSse(res.body)) {
    switch (event.type) {
      case "stdout":
        process.stdout.write(event.data);
        break;
      case "stderr":
        process.stderr.write(chalk.red(event.data));
        break;
      case "exit":
        exitCode = event.exit_code;
        break;
      case "error":
        console.error(chalk.red(`Remote error: ${event.message}`));
        exitCode = 1;
        break;
      default:
        break;
    }
  }

  return exitCode;
}

export function register(program: Command): void {
  program
    .command("exec <computer-or-host> <cmd> [args...]")
    .description("Run a command on a Computer or OpenComputers host")
    .option("--cwd <dir>", "Working directory on the host")
    .option("--env <KEY=VAL>", "Environment variable (repeatable)", collect, [])
    .option("--timeout <duration>", "Timeout e.g. 30s, 2m, 1h", "5m")
    .action(
      async (
        hostArg: string,
        cmd: string,
        args: string[],
        opts: { cwd?: string; env: string[]; timeout: string },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          let timeoutMs: number;
          try {
            timeoutMs = parseDuration(opts.timeout);
          } catch {
            console.error(
              chalk.red(`Invalid timeout: ${opts.timeout}. Use e.g. 30s, 2m`),
            );
            process.exit(1);
          }

          const spinner = spin(`Resolving ${hostArg}...`);
          const computer = await resolveComputer(client, hostArg);
          if (computer) {
            const status = String(
              computer.status ?? computer.state ?? "unknown",
            ).toLowerCase();
            if (!["running", "active", "unknown"].includes(status)) {
              spinner.warn(
                `Computer "${computer.name ?? computer.id}" is ${status}.`,
              );
            } else {
              spinner.stop();
            }
            const res = await client.computerExec(
              computer.id,
              computerCommand(cmd, args),
            );
            process.exit(await printStream(res));
            return;
          }

          spinner.text = `Resolving OpenComputers host ${hostArg}...`;
          const host = await client.getHost(hostArg);
          spinner.stop();
          const res = await client.streamJob(host.id, {
            cmd,
            args,
            cwd: opts.cwd,
            env: opts.env.length > 0 ? parseEnvPairs(opts.env) : undefined,
            timeout_ms: timeoutMs,
            stream: true,
          });
          process.exit(await printStream(res));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}
