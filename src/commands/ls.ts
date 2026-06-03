import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { formatBytes } from "../ui/progress.js";
import type { FsEntry } from "../types.js";

const SANDBOX_ID_RE = /^(sbx_|sb_)/;

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

          if (SANDBOX_ID_RE.test(hostName)) {
            const sandboxEntries = await listSandboxFs(
              client,
              hostName,
              remotePath,
            );
            renderEntries(sandboxEntries, opts);
            return;
          }

          const host = await client.getHost(hostName);
          let entries = await client.listFs(host.id, remotePath);

          renderEntries(entries, opts);
        } catch (err) {
          handleError(err);
        }
      },
    );
}

async function listSandboxFs(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
): Promise<FsEntry[]> {
  const result = await client.apiGet<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(remotePath)}`,
  );
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  const entries =
    data && typeof data === "object" && !Array.isArray(data)
      ? ((data as Record<string, unknown>)["entries"] ??
        (data as Record<string, unknown>)["files"] ??
        data)
      : data;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is Record<string, unknown> => {
      return !!entry && typeof entry === "object" && !Array.isArray(entry);
    })
    .map((entry) => {
      const name =
        typeof entry["name"] === "string"
          ? entry["name"]
          : typeof entry["path"] === "string"
            ? entry["path"].split("/").filter(Boolean).pop() || entry["path"]
            : "";
      const entryPath =
        typeof entry["path"] === "string"
          ? entry["path"]
          : `${remotePath.replace(/\/$/, "")}/${name}`;
      const rawType = String(entry["type"] ?? entry["kind"] ?? "file");
      const type =
        rawType === "dir" || rawType === "directory"
          ? "dir"
          : rawType === "symlink"
            ? "symlink"
            : "file";
      return {
        name,
        path: entryPath,
        type,
        size:
          typeof entry["size"] === "number"
            ? entry["size"]
            : typeof entry["bytes"] === "number"
              ? entry["bytes"]
              : null,
        mode:
          typeof entry["mode"] === "string"
            ? entry["mode"]
            : type === "dir"
              ? "rwxr-xr-x"
              : "rw-r--r--",
        modified_at:
          typeof entry["modified_at"] === "string"
            ? entry["modified_at"]
            : typeof entry["mtime"] === "string"
              ? entry["mtime"]
              : null,
      } satisfies FsEntry;
    });
}

function renderEntries(
  entries: FsEntry[],
  opts: { all?: boolean; long?: boolean },
): void {
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
        entry.size !== null ? formatBytes(entry.size).padStart(8) : "       -";
      const modified = entry.modified_at
        ? new Date(entry.modified_at).toLocaleString()
        : chalk.dim("          unknown");
      console.log(`${mode}  ${size}  ${modified}  ${colorName(entry)}`);
    }
    return;
  }

  const names = entries.map((e) => colorName(e));
  const colWidth = Math.max(...entries.map((e) => e.name.length + 2)) + 2;
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
