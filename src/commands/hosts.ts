import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import type { Host, HostState } from "../types.js";
import { handleError } from "./util.js";

function stateColor(state: HostState): string {
  switch (state) {
    case "online":
      return chalk.green(state);
    case "offline":
    case "disconnected":
      return chalk.dim(state);
    case "error":
      return chalk.red(state);
    case "pending":
      return chalk.yellow(state);
    default:
      return state;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relativeTime(iso: string | null): string {
  if (!iso) return chalk.dim("never");
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function register(
  program: Command,
  options: {
    command?: string;
    description?: string;
    emptyHint?: string;
  } = {},
): void {
  program
    .command(options.command ?? "hosts")
    .description(options.description ?? "List all OpenComputers hosts")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const hosts = await client.listHosts();

        if (opts.json) {
          console.log(JSON.stringify(hosts, null, 2));
          return;
        }

        if (hosts.length === 0) {
          console.log(
            chalk.dim(
              options.emptyHint ??
                "No hosts found. Add one with: miosa opencomputers connect <name>",
            ),
          );
          return;
        }

        renderTable<Host>(hosts, [
          {
            header: "ID",
            key: (h) => shortId(h.id),
            width: 10,
          },
          {
            header: "NAME",
            key: "name",
            width: 24,
          },
          {
            header: "STATE",
            key: (h) => stateColor(h.state),
            width: 12,
          },
          {
            header: "OS",
            key: (h) => h.os ?? chalk.dim("unknown"),
            width: 14,
          },
          {
            header: "LAST SEEN",
            key: (h) => relativeTime(h.last_heartbeat),
            width: 14,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });
}
