import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError, parseEnvPairs, parseDuration } from "./util.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("exec <host> <cmd> [args...]")
    .description("Run a command on a host and stream output")
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

          const spinner = spin(`Resolving host ${hostArg}...`);
          const host = await client.getHost(hostArg);
          spinner.stop();

          let timeoutMs: number;
          try {
            timeoutMs = parseDuration(opts.timeout);
          } catch {
            console.error(
              chalk.red(`Invalid timeout: ${opts.timeout}. Use e.g. 30s, 2m`),
            );
            process.exit(1);
          }

          const res = await client.streamJob(host.id, {
            cmd,
            args,
            cwd: opts.cwd,
            env: opts.env.length > 0 ? parseEnvPairs(opts.env) : undefined,
            timeout_ms: timeoutMs,
            stream: true,
          });

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
              case "done":
                break;
              default:
                break;
            }
          }

          process.exit(exitCode);
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}
