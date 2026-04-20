import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { formatBytes } from "../ui/progress.js";
import type { FsEntry } from "../types.js";

function formatMode(entry: FsEntry): string {
  const typeChar =
    entry.type === "dir" ? "d" : entry.type === "symlink" ? "l" : "-";
  return typeChar + (entry.mode ?? "rwxr-xr-x");
}

function colorName(entry: FsEntry): string {
  if (entry.type === "dir") return chalk.blue(entry.name + "/");
  if (entry.type === "symlink") return chalk.cyan(entry.name);
  return entry.name;
}

export function register(program: Command): void {
  program
    .command("ls <host-path>")
    .description("List files on a host (host:/path syntax)")
    .option("-a, --all", "Show hidden files")
    .option("-l, --long", "Long format")
    .action(
      async (hostPath: string, opts: { all?: boolean; long?: boolean }) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const { host: hostName, path: remotePath } = parseHostPath(hostPath);

          const host = await client.getHost(hostName);
          let entries = await client.listFs(host.id, remotePath);

          if (!opts.all) {
            entries = entries.filter((e) => !e.name.startsWith("."));
          }

          if (entries.length === 0) {
            console.log(chalk.dim("(empty)"));
            return;
          }

          if (opts.long) {
            for (const entry of entries) {
              const mode = formatMode(entry);
              const size =
                entry.size !== null
                  ? formatBytes(entry.size).padStart(8)
                  : "       -";
              const modified = entry.modified_at
                ? new Date(entry.modified_at).toLocaleString()
                : chalk.dim("          unknown");
              console.log(`${mode}  ${size}  ${modified}  ${colorName(entry)}`);
            }
          } else {
            // Grid output — 4 per row
            const names = entries.map((e) => colorName(e));
            const colWidth =
              Math.max(...entries.map((e) => e.name.length + 2)) + 2;
            const cols = Math.max(
              1,
              Math.floor((process.stdout.columns ?? 80) / colWidth),
            );
            for (let i = 0; i < names.length; i += cols) {
              console.log(
                names
                  .slice(i, i + cols)
                  .map((n) => n.padEnd(colWidth))
                  .join(""),
              );
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );
}
