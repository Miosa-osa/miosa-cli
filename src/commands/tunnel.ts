import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { parseSse } from "../client.js";
import type { Tunnel } from "../types.js";

export function register(program: Command): void {
  // miosa tunnel <host> --port <N> [--name slug] [--watch]
  const tunnelCmd = program
    .command("tunnel")
    .description("Manage tunnels on a host");

  tunnelCmd
    .command("open <host>")
    .description("Open a public tunnel on a host port")
    .requiredOption("--port <n>", "Local port on the host to expose", parseInt)
    .option("--name <slug>", "Optional tunnel name/slug")
    .option("--watch", "Stay open and stream live tunnel events")
    .action(
      async (
        hostArg: string,
        opts: { port: number; name?: string; watch?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const spinner = spin(`Resolving host ${hostArg}...`);
          const host = await client.getHost(hostArg);
          spinner.text = "Opening tunnel...";

          const tunnel = await client.createTunnel(host.id, {
            port: opts.port,
            name: opts.name,
          });

          spinner.succeed(`Tunnel open: ${chalk.cyan(tunnel.public_url)}`);
          console.log(
            chalk.dim(`  Slug: ${tunnel.slug}  Port: ${tunnel.port}`),
          );

          if (opts.watch) {
            console.log(chalk.dim("\nWatching for events (Ctrl+C to stop)..."));
            const res = await client.watchEvents(host.id);
            for await (const event of parseSse(res.body)) {
              if (event.type === "heartbeat") continue;
              const ts = new Date().toLocaleTimeString();
              console.log(
                `${chalk.dim(ts)}  ${chalk.yellow(event.type)}  ${formatEvent(event)}`,
              );
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  tunnelCmd
    .command("list <host>")
    .alias("ls")
    .description("List tunnels on a host")
    .option("--json", "Output as JSON")
    .action(async (hostArg: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const host = await client.getHost(hostArg);
        const tunnels = await client.listTunnels(host.id);

        if (opts.json) {
          console.log(JSON.stringify(tunnels, null, 2));
          return;
        }

        if (tunnels.length === 0) {
          console.log(chalk.dim("No tunnels."));
          return;
        }

        renderTable<Tunnel>(tunnels, [
          { header: "SLUG", key: "slug", width: 20 },
          { header: "PORT", key: (t) => String(t.port), width: 6 },
          { header: "PUBLIC URL", key: "public_url", width: 40 },
          { header: "STATE", key: "state", width: 8 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  tunnelCmd
    .command("close <host> <slug>")
    .description("Close (revoke) a tunnel")
    .action(async (hostArg: string, slug: string) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const host = await client.getHost(hostArg);
        const spinner = spin(`Closing tunnel ${slug}...`);
        await client.closeTunnel(
          host.id,
          slug as import("../types.js").TunnelSlug,
        );
        spinner.succeed(`Tunnel ${slug} closed.`);
      } catch (err) {
        handleError(err);
      }
    });
}

function formatEvent(event: import("../types.js").SseEvent): string {
  switch (event.type) {
    case "stdout":
    case "stderr":
      return event.data.trim();
    case "error":
      return chalk.red(event.message);
    case "thought":
      return chalk.italic(event.content);
    case "tool_call":
      return `${event.tool}(${JSON.stringify(event.input)})`;
    case "tool_result":
      return `${event.tool} → ${JSON.stringify(event.output)}`;
    case "exit":
      return `exit ${event.exit_code}`;
    case "done":
      return "done";
    default:
      return "";
  }
}
