import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("watch <host>")
    .description("Stream live telemetry and events from a host")
    .action(async (hostArg: string) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const spinner = spin(`Connecting to ${hostArg}...`);
        const host = await client.getHost(hostArg);
        spinner.succeed(`Watching ${host.name} (Ctrl+C to stop)`);
        console.log();

        const res = await client.watchEvents(host.id);

        process.on("SIGINT", () => {
          console.log(chalk.dim("\nStopped."));
          process.exit(0);
        });

        for await (const event of parseSse(res.body)) {
          const ts = chalk.dim(new Date().toLocaleTimeString());

          switch (event.type) {
            case "heartbeat":
              process.stdout.write(chalk.dim("."));
              break;
            case "stdout":
              console.log(
                `${ts} ${chalk.white("stdout")}  ${event.data.trim()}`,
              );
              break;
            case "stderr":
              console.log(`${ts} ${chalk.red("stderr")}  ${event.data.trim()}`);
              break;
            case "thought":
              console.log(
                `${ts} ${chalk.magenta("thought")}  ${event.content}`,
              );
              break;
            case "tool_call":
              console.log(
                `${ts} ${chalk.blue("tool")}    ${event.tool}(${chalk.dim(JSON.stringify(event.input))})`,
              );
              break;
            case "tool_result":
              console.log(
                `${ts} ${chalk.green("result")}  ${event.tool} → ${chalk.dim(JSON.stringify(event.output))}`,
              );
              break;
            case "error":
              console.log(`${ts} ${chalk.red("error")}   ${event.message}`);
              break;
            case "done":
              console.log(`${ts} ${chalk.green("done")}`);
              break;
            case "exit":
              console.log(
                `${ts} ${chalk.dim("exit")}    code=${event.exit_code}`,
              );
              break;
            case "unknown":
              if (process.env["MIOSA_DEBUG"]) {
                console.log(`${ts} ${chalk.dim("raw")}     ${event.raw}`);
              }
              break;
          }
        }
      } catch (err) {
        handleError(err);
      }
    });
}
