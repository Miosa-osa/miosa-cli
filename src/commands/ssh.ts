import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { runWsPty } from "../pty/ws-pty-client.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("ssh <host>")
    .description("Open an interactive terminal session on a host")
    .option("--cmd <command>", "Run a single command and exit (best-effort)")
    .action(async (hostArg: string, opts: { cmd?: string }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const spinner = spin(`Connecting to ${hostArg}...`);
        const host = await client.getHost(hostArg);

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
