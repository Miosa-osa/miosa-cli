import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { formatBytes } from "../ui/progress.js";
import { UserError } from "../errors.js";
import type { FsEntry } from "../types.js";
import { isJsonMode } from "../cli-env.js";

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
    .option("--json", "Output as JSON")
    .action(
      async (
        hostPath: string,
        opts: { all?: boolean; long?: boolean; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const { host: hostName, path: remotePath } = parseHostPath(hostPath);

          let entries: FsEntry[];
          try {
            const host = await client.getHost(hostName);
            entries = await client.listFs(host.id, remotePath);
          } catch (err) {
            entries = await listSandboxPath(client, hostName, remotePath, err);
          }

          if (!opts.all) {
            entries = entries.filter((e) => !e.name.startsWith("."));
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(entries, null, 2));
            return;
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

async function listSandboxPath(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
  hostError: unknown,
): Promise<FsEntry[]> {
  try {
    await client.apiGet<unknown>(
      `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );
  } catch {
    if (hostError instanceof Error) throw hostError;
    throw new UserError(`Remote target not found: ${sandboxId}`);
  }

  const result = await client.apiPost<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
    {
      command: `find ${shellQuote(remotePath)} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\t%M\\t%T@\\n'`,
      cwd: "/",
      dir: "/",
    },
  );
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  const stdout =
    data && typeof data === "object" && !Array.isArray(data)
      ? String((data as Record<string, unknown>)["stdout"] ?? "")
      : "";
  if (!stdout.trim()) return [];
  return stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", type = "f", size = "0", mode = "----------", ts = ""] =
        line.split("\t");
      return {
        name,
        path: `${remotePath.replace(/\/$/, "")}/${name}`,
        type:
          type === "d" ? "dir" : type === "l" ? "symlink" : "file",
        size: Number.parseInt(size, 10),
        mode: mode.slice(1),
        modified_at: ts ? new Date(Number(ts) * 1000).toISOString() : null,
      } as FsEntry;
    });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
