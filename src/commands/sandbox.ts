import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import chalk from "chalk";
import {
  addDataOption,
  client,
  apiPath,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  printValue,
  runAction,
  unwrap,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { loadConfig } from "../config.js";
import { handleError } from "./util.js";
import { renderTable } from "../ui/table.js";
import {
  formatDuration,
  hintBlock,
  icon,
  kvPanel,
  printBanner,
  printElapsed,
} from "../ui/render.js";

export function register(program: Command): void {
  // -------------------------------------------------------------------------
  // sandbox / sandboxes command group — built manually to avoid subcommand
  // conflicts that arise when using the resourceCommands helper alongside
  // custom create/exec/file subcommands.
  // -------------------------------------------------------------------------
  const sandbox = program
    .command("sandbox")
    .alias("sandboxes")
    .description(
      "Manage Sandboxes — lightweight code-only Computers (Firecracker microVMs without a desktop)",
    );

  // list
  sandbox
    .command("list")
    .description("List all Sandboxes")
    .option("--state <state>", "Filter by state (running, paused, …)")
    .option("--json", "Output as JSON")
    .action((opts: { state?: string } & JsonOptions) =>
      runAction(async () => {
        const qs = opts.state ? `?state=${enc(opts.state)}` : "";

        if (opts.json) {
          await getAndPrint(`/sandboxes${qs}`, opts);
          return;
        }

        const raw = unwrap(
          await client().apiGet<unknown>(apiPath(`/sandboxes${qs}`)),
        );
        const items: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : [];

        console.log();
        console.log(
          `  ${icon.info}  ${chalk.bold(String(items.length))} ${chalk.dim("sandbox(es)")}`,
        );
        console.log();

        if (items.length === 0) {
          console.log(
            kvPanel([
              { label: "Sandboxes", value: chalk.dim("0  — none created yet") },
            ]),
          );
          console.log();
          console.log(hintBlock("Try", ["miosa sandbox create"]));
          console.log();
          return;
        }

        renderTable(items, [
          { header: "ID", key: "id" as keyof Record<string, unknown> },
          { header: "NAME", key: "name" as keyof Record<string, unknown> },
          {
            header: "STATUS",
            key: "status" as keyof Record<string, unknown>,
            color: (val) => statusColor(val.trim()),
          },
          {
            header: "TEMPLATE",
            key: "template_id" as keyof Record<string, unknown>,
          },
          {
            header: "CREATED",
            key: "created_at" as keyof Record<string, unknown>,
          },
        ]);

        console.log();
        console.log(
          hintBlock("Try", [
            "miosa sandbox show <id>",
            "miosa sandbox exec <id> --command ...",
            "miosa sandbox create",
          ]),
        );
        console.log();
      }),
    );

  // ls — muscle-memory alias for list
  sandbox
    .command("ls")
    .description("Alias for list")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/sandboxes", opts)),
    );

  // show — canonical resourceCommands-style name
  sandbox
    .command("show <sandbox-id>")
    .description("Show a Sandbox by ID")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        if (opts.json) {
          await getAndPrint(`/sandboxes/${enc(id)}`, opts);
          return;
        }

        const raw = unwrap(
          await client().apiGet<unknown>(apiPath(`/sandboxes/${enc(id)}`)),
        );
        const sb = (raw ?? {}) as Record<string, unknown>;

        printBanner({ subtitle: "Sandbox" });

        const rows = [
          { label: "ID", value: chalk.bold(str(sb["id"])), icon: icon.info },
          { label: "Name", value: str(sb["name"]) },
          {
            label: "Status",
            value: statusColor(str(sb["status"])),
          },
        ];
        if (sb["template_id"]) {
          rows.push({ label: "Template", value: str(sb["template_id"]) });
        }
        if (sb["cpu_count"] != null) {
          rows.push({ label: "CPU", value: str(sb["cpu_count"]) });
        }
        if (sb["memory_mb"] != null) {
          rows.push({
            label: "Memory",
            value: `${str(sb["memory_mb"])} MB`,
          });
        }
        if (sb["timeout_sec"] != null) {
          rows.push({
            label: "Timeout",
            value: `${str(sb["timeout_sec"])} sec`,
          });
        }
        if (sb["ip_address"]) {
          rows.push({ label: "IP", value: str(sb["ip_address"]) });
        }
        if (sb["public_url"]) {
          rows.push({
            label: "URL",
            value: chalk.cyan(str(sb["public_url"])),
          });
        }
        if (sb["created_at"]) {
          rows.push({
            label: "Created",
            value: chalk.dim(str(sb["created_at"])),
          });
        }

        console.log(kvPanel(rows));
        console.log();
        console.log(
          hintBlock("Try", [
            `miosa sandbox exec ${str(sb["id"])} --command ...`,
            `miosa sandbox destroy ${str(sb["id"])}`,
          ]),
        );
        console.log();
      }),
    );

  // get — matches documented form: miosa sandboxes get <id>
  sandbox
    .command("get <sandbox-id>")
    .description("Show a Sandbox by ID (alias for show)")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/sandboxes/${enc(id)}`, opts)),
    );

  // create — typed flags for common options; --data JSON overrides all flags
  addDataOption(
    sandbox
      .command("create")
      .description("Create a new Sandbox")
      .option(
        "--template <template>",
        "Template / image ID (default: miosa-sandbox)",
      )
      .option("--name <name>", "Human-readable name for the Sandbox")
      .option("--cpu <n>", "vCPU count", parseInt)
      .option("--memory <mb>", "Memory in MB", parseInt)
      .option("--disk <mb>", "Disk size in MB", parseInt)
      .option("--timeout <sec>", "Idle timeout in seconds", parseInt)
      .option("--always-on", "Disable auto-destroy on idle"),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        opts: DataOptions & {
          template?: string;
          name?: string;
          cpu?: number;
          memory?: number;
          disk?: number;
          timeout?: number;
          alwaysOn?: boolean;
        },
      ) =>
        runAction(async () => {
          const t0 = Date.now();

          if (opts.data) {
            if (opts.json) {
              await postAndPrint("/sandboxes", opts, {});
              return;
            }
            const raw = unwrap(
              await client().apiPost<unknown>(apiPath("/sandboxes"), {}),
            );
            renderCreateSuccess(raw, Date.now() - t0);
            return;
          }

          const body: Record<string, unknown> = {};
          if (opts.template) body["template_id"] = opts.template;
          if (opts.name) body["name"] = opts.name;
          if (opts.cpu != null) body["cpu_count"] = opts.cpu;
          if (opts.memory != null) body["memory_mb"] = opts.memory;
          if (opts.disk != null) body["disk_size_mb"] = opts.disk;
          if (opts.timeout != null) body["timeout_sec"] = opts.timeout;
          if (opts.alwaysOn) body["always_on"] = true;

          if (opts.json) {
            await postAndPrint("/sandboxes", opts, body);
            return;
          }

          const raw = unwrap(
            await client().apiPost<unknown>(apiPath("/sandboxes"), body),
          );
          renderCreateSuccess(raw, Date.now() - t0);
        }),
    );

  // delete
  sandbox
    .command("delete <sandbox-id>")
    .description("Delete a Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/sandboxes/${enc(id)}`, opts)),
    );

  // destroy / rm — aliases for delete
  sandbox
    .command("destroy <sandbox-id>")
    .alias("rm")
    .description("Destroy a Sandbox (alias for delete)")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/sandboxes/${enc(id)}`, opts)),
    );

  // action — lifecycle operations: pause, resume
  addDataOption(
    sandbox
      .command("action <sandbox-id> <action>")
      .description("Run a lifecycle action: pause, resume"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, action: string, opts: DataOptions) =>
      runAction(async () => {
        const allowed = ["pause", "resume"];
        if (!allowed.includes(action)) {
          throw new Error(
            `Unsupported action "${action}". Use: ${allowed.join(", ")}`,
          );
        }
        await postAndPrint(`/sandboxes/${enc(id)}/${enc(action)}`, opts, {});
      }),
    );

  // exec — positional command arg; --data body overrides when supplied
  addDataOption(
    sandbox
      .command("exec <sandbox-id> [command...]")
      .description(
        "Run a command inside a Sandbox (positional args joined as shell command)",
      )
      .option("--cwd <path>", "Working directory inside the Sandbox")
      .option("--timeout <sec>", "Exec timeout in seconds", parseInt),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: DataOptions & { cwd?: string; timeout?: number },
      ) =>
        runAction(async () => {
          if (opts.data) {
            await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, {});
            return;
          }
          const cmd = words.join(" ");
          const body: Record<string, unknown> = cmd ? { command: cmd } : {};
          if (opts.cwd) body["cwd"] = opts.cwd;
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, body);
        }),
    );

  // run — alias for exec with identical semantics
  addDataOption(
    sandbox
      .command("run <sandbox-id> [command...]")
      .description("Run a command inside a Sandbox (alias for exec)")
      .option("--cwd <path>", "Working directory inside the Sandbox")
      .option("--timeout <sec>", "Exec timeout in seconds", parseInt),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: DataOptions & { cwd?: string; timeout?: number },
      ) =>
        runAction(async () => {
          if (opts.data) {
            await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, {});
            return;
          }
          const cmd = words.join(" ");
          const body: Record<string, unknown> = cmd ? { command: cmd } : {};
          if (opts.cwd) body["cwd"] = opts.cwd;
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, body);
        }),
    );

  // write-file — POST /sandboxes/:id/files with base64 content.
  // If <content-or-file> is an existing local path, reads the file bytes;
  // otherwise treats the argument as literal UTF-8 text.
  sandbox
    .command("write-file <sandbox-id> <remote-path> <content-or-file>")
    .description(
      "Write a file inside a Sandbox (pass literal text or a local file path)",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        remotePath: string,
        contentArg: string,
        opts: JsonOptions,
      ) => {
        try {
          const contentBytes: Buffer = fs.existsSync(contentArg)
            ? fs.readFileSync(contentArg)
            : Buffer.from(contentArg, "utf8");
          const base64 = contentBytes.toString("base64");
          const c = client();
          const result = await c.apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/files`),
            { path: remotePath, content: base64 },
          );
          if (!opts.json) {
            console.log(chalk.green(`Written to ${remotePath}`));
          } else {
            printValue(result, opts);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // read-file — GET /sandboxes/:id/files/:path, decode base64 content and print.
  sandbox
    .command("read-file <sandbox-id> <remote-path>")
    .description("Read a file from inside a Sandbox and print its contents")
    .option("--json", "Output raw JSON response")
    .action(async (id: string, remotePath: string, opts: JsonOptions) => {
      try {
        const encoded = enc(remotePath.replace(/^\//, ""));
        const c = client();
        const result = await c.apiGet<unknown>(
          apiPath(`/sandboxes/${enc(id)}/files/${encoded}`),
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const data =
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result)
            ? ((result as Record<string, unknown>)["data"] ?? result)
            : result;
        const contentVal =
          data !== null &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          "content" in data &&
          typeof (data as Record<string, unknown>)["content"] === "string"
            ? ((data as Record<string, unknown>)["content"] as string)
            : null;
        if (contentVal !== null) {
          process.stdout.write(Buffer.from(contentVal, "base64"));
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      } catch (err) {
        handleError(err);
      }
    });

  // upload — read local binary file, POST to /sandboxes/:id/files as base64.
  sandbox
    .command("upload <sandbox-id> <local-path> <remote-path>")
    .description("Upload a local file into a Sandbox")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        localPath: string,
        remotePath: string,
        opts: JsonOptions,
      ) => {
        try {
          if (!fs.existsSync(localPath)) {
            console.error(chalk.red(`File not found: ${localPath}`));
            process.exit(1);
          }
          const data = fs.readFileSync(localPath);
          const base64 = data.toString("base64");
          const c = client();
          const result = await c.apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/files`),
            { path: remotePath, content: base64 },
          );
          if (opts.json) {
            printValue(result, opts);
          } else {
            const filename = path.basename(localPath);
            console.log(chalk.green(`Uploaded ${filename} → ${remotePath}`));
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // download — GET /sandboxes/:id/files/:path; write to --output or stdout.
  sandbox
    .command("download <sandbox-id> <remote-path>")
    .description("Download a file from a Sandbox to a local path or stdout")
    .option("--output <file>", "Write to this local file instead of stdout")
    .option("--json", "Output raw JSON response")
    .action(
      async (
        id: string,
        remotePath: string,
        opts: { output?: string; json?: boolean },
      ) => {
        try {
          const encoded = enc(remotePath.replace(/^\//, ""));
          const c = client();
          const result = await c.apiGet<unknown>(
            apiPath(`/sandboxes/${enc(id)}/files/${encoded}`),
          );

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          const data =
            result !== null &&
            typeof result === "object" &&
            !Array.isArray(result)
              ? ((result as Record<string, unknown>)["data"] ?? result)
              : result;

          const downloadContent =
            data !== null &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            "content" in data &&
            typeof (data as Record<string, unknown>)["content"] === "string"
              ? ((data as Record<string, unknown>)["content"] as string)
              : null;
          const bytes: Buffer =
            downloadContent !== null
              ? Buffer.from(downloadContent, "base64")
              : Buffer.from(JSON.stringify(data, null, 2), "utf8");

          if (opts.output) {
            fs.writeFileSync(opts.output, bytes);
            console.log(
              chalk.green(`Downloaded ${remotePath} → ${opts.output}`),
            );
          } else {
            process.stdout.write(bytes);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // logs — GET /sandboxes/:id/logs
  sandbox
    .command("logs <sandbox-id>")
    .description("Show Sandbox logs")
    .option("--lines <n>", "Number of log lines to fetch", parseInt)
    .option("--json", "Output as JSON")
    .action((id: string, opts: { lines?: number } & JsonOptions) =>
      runAction(async () => {
        const qs = opts.lines != null ? `?lines=${opts.lines}` : "";
        await getAndPrint(`/sandboxes/${enc(id)}/logs${qs}`, opts);
      }),
    );

  // ssh — open browser terminal via platform PTY endpoint
  sandbox
    .command("ssh <sandbox-id>")
    .description("Open an interactive terminal session for a Sandbox")
    .option("--print-url", "Print the URL instead of opening a browser")
    .option("--json", "Output as JSON")
    .action(
      async (id: string, opts: { printUrl?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const baseUrl = (config.endpoint || "https://api.miosa.ai").replace(
          /\/$/,
          "",
        );
        const url = `${baseUrl}/api/v1/sandboxes/${enc(id)}/terminal`;

        if (opts.json) {
          console.log(JSON.stringify({ url }, null, 2));
          return;
        }
        if (opts.printUrl) {
          console.log(url);
          return;
        }
        openUrl(url);
        console.log(`Opening terminal for sandbox ${id}...`);
      },
    );

  // checkpoint — POST /sandboxes/:id/snapshots
  addDataOption(
    sandbox
      .command("checkpoint <sandbox-id>")
      .description("Create a Checkpoint (memory state snapshot) of a Sandbox"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/sandboxes/${enc(id)}/snapshots`, opts, {}),
      ),
    );

  // delete-checkpoint / delete-snapshot
  sandbox
    .command("delete-checkpoint <sandbox-id> <checkpoint-id>")
    .alias("delete-snapshot")
    .description("Delete a Sandbox Checkpoint")
    .option("--json", "Output as JSON")
    .action((id: string, sid: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/sandboxes/${enc(id)}/snapshots/${enc(sid)}`, opts),
      ),
    );

  // -------------------------------------------------------------------------
  // sandbox-templates — top-level command group for template management
  // -------------------------------------------------------------------------
  const templates = program
    .command("sandbox-templates")
    .description("Manage Sandbox templates");

  templates
    .command("list")
    .description("List all available Sandbox templates")
    .option("--include-aliases", "Include template aliases in the response")
    .option("--json", "Output as JSON")
    .action((opts: { includeAliases?: boolean } & JsonOptions) =>
      runAction(async () => {
        const qs = opts.includeAliases ? "?include_aliases=true" : "";
        await getAndPrint(`/sandbox-templates${qs}`, opts);
      }),
    );

  templates
    .command("get <template-id>")
    .description("Show a Sandbox template by ID or slug")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/sandbox-templates/${enc(id)}`, opts)),
    );
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// ── Sandbox render helpers ────────────────────────────────────────────────

/** Coerce an unknown API field to a display string. */
function str(v: unknown): string {
  if (v === null || v === undefined) return chalk.dim("—");
  return String(v);
}

/** Apply semantic color to a sandbox status string. */
function statusColor(s: string): string {
  const lower = s.toLowerCase().trim();
  if (lower === "running") return chalk.green(s);
  if (lower === "paused" || lower === "suspended") return chalk.yellow(s);
  if (
    lower === "stopped" ||
    lower === "error" ||
    lower === "failed" ||
    lower === "destroyed"
  )
    return chalk.red(s);
  if (lower === "starting" || lower === "provisioning" || lower === "pending")
    return chalk.cyan(s);
  return chalk.dim(s);
}

/** Render the create-success panel. */
function renderCreateSuccess(raw: unknown, elapsedMs: number): void {
  const sb = (raw ?? {}) as Record<string, unknown>;
  const id = str(sb["id"]);

  printBanner({ subtitle: "Create sandbox" });

  console.log(
    kvPanel([
      { icon: icon.ok, label: "ID", value: chalk.bold(id) },
      { label: "Name", value: str(sb["name"]) },
      { label: "Status", value: statusColor(str(sb["status"])) },
    ]),
  );
  console.log();
  console.log(
    hintBlock("Next", [
      `miosa sandbox show ${id}`,
      `miosa sandbox exec ${id} --command 'python -c print(2+2)'`,
    ]),
  );
  printElapsed(formatDuration(elapsedMs));
}
