import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("agent <host> <task>")
    .description("Dispatch an AI agent task on a host")
    .option("--model <model>", "Model override (e.g. nemotron-3-super)")
    .option("--steps <n>", "Max agent steps", "10")
    .option("--timeout <ms>", "Timeout in ms", "300000")
    .option("--tools <list>", "Comma-separated tool list", "exec,fs")
    .action(
      async (
        hostArg: string,
        task: string,
        opts: {
          model?: string;
          steps: string;
          timeout: string;
          tools: string;
        },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const spinner = spin(`Resolving host ${hostArg}...`);
          const host = await client.getHost(hostArg);
          spinner.succeed(`Agent dispatching on ${host.name}`);
          console.log(chalk.dim(`  Task: ${task}`));
          console.log();

          const res = await client.dispatchAgent(host.id, {
            task,
            model: opts.model,
            tools: opts.tools.split(",").map((t) => t.trim()),
            budget: {
              max_steps: parseInt(opts.steps, 10),
              timeout_ms: parseInt(opts.timeout, 10),
            },
          });

          let stepCount = 0;

          for await (const event of parseSse(res.body)) {
            const ts = chalk.dim(new Date().toLocaleTimeString());
            switch (event.type) {
              case "thought":
                console.log(
                  `${ts} ${chalk.magenta("◆ thought")}  ${chalk.italic(event.content)}`,
                );
                break;
              case "tool_call":
                stepCount++;
                console.log(
                  `${ts} ${chalk.blue(`→ ${event.tool}`)}  ${chalk.dim(JSON.stringify(event.input))}`,
                );
                break;
              case "tool_result":
                console.log(
                  `${ts} ${chalk.green(`← ${event.tool}`)}  ${chalk.dim(truncate(JSON.stringify(event.output), 120))}`,
                );
                break;
              case "stdout":
                process.stdout.write(event.data);
                break;
              case "stderr":
                process.stderr.write(chalk.red(event.data));
                break;
              case "error":
                console.error(
                  `${ts} ${chalk.red("✗ error")}  ${event.message}`,
                );
                break;
              case "done":
                console.log();
                console.log(
                  chalk.green(
                    `Agent completed (${stepCount} step${stepCount !== 1 ? "s" : ""})`,
                  ),
                );
                if (event.result !== undefined) {
                  console.log(
                    chalk.dim("Result: ") +
                      JSON.stringify(event.result, null, 2),
                  );
                }
                break;
              case "heartbeat":
                break;
              default:
                if (process.env["MIOSA_DEBUG"]) {
                  console.log(chalk.dim(`[${event.type}]`));
                }
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
