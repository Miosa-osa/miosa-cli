import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import chalk from "chalk";
import WebSocket from "ws";
import { detectFramework } from "../framework-detector.js";
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
import { formatBytes } from "../ui/progress.js";
import { UserError } from "../errors.js";

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
    .option("--port <port>", "Include live preview readiness for this port", parseIntegerOption)
    .option("--probe-path <path>", "HTTP path to probe when --port is set", "/")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions & { port?: number; probePath: string }) =>
      runAction(async () => {
        if (opts.json) {
          const data =
            opts.port != null
              ? await showSandboxWithPreview(id, opts.port, opts.probePath)
              : unwrap(
                  await client().apiGet<unknown>(
                    apiPath(`/sandboxes/${enc(id)}`),
                  ),
                );
          console.log(JSON.stringify(data, null, 2));
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
            `miosa sandbox preview ${str(sb["id"])} --port 5173 --wait`,
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
      .option("--cpu <n>", "vCPU count", parseIntegerOption)
      .option("--memory <size>", "Memory size, e.g. 4096mb or 4gb", parseSizeMb)
      .option("--disk <size>", "Disk size, e.g. 10240mb or 10gb", parseSizeMb)
      .option("--timeout <duration>", "Wall-clock timeout, e.g. 300s, 1h", parseDurationSec)
      .option("--publish-port <port>", "Expose this port after create", parseIntegerOption)
      .option("--wait", "Wait for sandbox running and published port readiness")
      .option("--probe-path <path>", "HTTP path to probe when --publish-port is set", "/")
      .option("--source <source>", "Source: git:https://..., tarball:https://..., or snapshot:<id>")
      .option("--revision <revision>", "Git revision/branch when --source git: is used")
      .option("--depth <n>", "Git clone depth when --source git: is used", parseIntegerOption)
      .option("--snapshot <id>", "Create from a sandbox snapshot")
      .option("--workspace <id-or-slug>", "Workspace ID/slug")
      .option("--network-policy <policy>", "Network policy: allow-all or deny-all")
      .option("--allowed-domain <domain>", "Allowed egress domain. Repeatable.", collectOption, [])
      .option("--allowed-cidr <cidr>", "Allowed egress CIDR. Repeatable.", collectOption, [])
      .option("--denied-cidr <cidr>", "Denied egress CIDR. Repeatable.", collectOption, [])
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
          publishPort?: number;
          wait?: boolean;
          probePath?: string;
          source?: string;
          revision?: string;
          depth?: number;
          snapshot?: string;
          workspace?: string;
          networkPolicy?: string;
          allowedDomain?: string[];
          allowedCidr?: string[];
          deniedCidr?: string[];
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
          if (opts.source) body["source"] = opts.source;
          if (opts.revision) body["revision"] = opts.revision;
          if (opts.depth != null) body["depth"] = opts.depth;
          if (opts.snapshot) body["snapshot_id"] = opts.snapshot;
          if (opts.workspace) body["workspace_id"] = opts.workspace;
          const networkPolicy = buildNetworkPolicy(opts);
          if (networkPolicy) {
            body["metadata"] = {
              ...((body["metadata"] as Record<string, unknown> | undefined) ?? {}),
              network_policy: networkPolicy,
            };
          }
          if (opts.alwaysOn) body["always_on"] = true;

          const raw = unwrap(
            await client().apiPost<unknown>(apiPath("/sandboxes"), body),
          );
          const sb = (raw ?? {}) as Record<string, unknown>;
          const id = String(sb["id"] ?? "");

          if (opts.publishPort != null && id) {
            if (opts.wait) {
              const preview = await waitSandboxReady(
                id,
                opts.publishPort,
                opts.probePath ?? "/",
                Math.max(opts.timeout ?? 120, 30),
              );
              sb["preview"] = preview;
              sb["preview_url"] = preview.url;
              sb["ready"] = preview.ready;
            } else {
              const preview = await previewSandbox(id, opts.publishPort, {
                wait: false,
                timeout: 1,
                probePath: opts.probePath ?? "/",
              });
              sb["preview"] = preview;
              sb["preview_url"] = preview.url;
            }
          } else if (opts.wait && id) {
            const latest = await waitForSandboxRunning(
              client(),
              id,
              Math.max(opts.timeout ?? 120, 30),
            );
            Object.assign(sb, latest, { ready: true });
          }

          if (opts.json) {
            console.log(JSON.stringify(sb, null, 2));
            return;
          }

          renderCreateSuccess(sb, Date.now() - t0);
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

  // stop — snapshot + pause (mirrors `box stop`)
  sandbox
    .command("stop <sandbox-id>")
    .description("Snapshot the Sandbox and pause billing")
    .option("--no-snapshot", "Skip the snapshot step (pause only)")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { snapshot?: boolean } & JsonOptions) =>
      runAction(async () => {
        if (opts.snapshot !== false) {
          await postAndPrint(`/sandboxes/${enc(id)}/snapshots`, opts, {});
        }
        await postAndPrint(`/sandboxes/${enc(id)}/pause`, opts, {});
      }),
    );

  // resume — direct shortcut (mirrors `box resume`)
  sandbox
    .command("resume <sandbox-id>")
    .description("Resume a paused Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => postAndPrint(`/sandboxes/${enc(id)}/resume`, opts, {})),
    );

  // fork — clone from snapshot in one call (mirrors `box fork`)
  sandbox
    .command("fork <sandbox-id>")
    .description("Clone (fork) a Sandbox from its current state")
    .option("--name <name>", "Optional name for the forked Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: { name?: string } & JsonOptions) =>
      runAction(async () => {
        const body: Record<string, unknown> = {};
        if (opts.name) body["name"] = opts.name;
        await postAndPrint(`/sandboxes/${enc(id)}/fork`, opts, body);
      }),
    );

  // desktop — open the Sandbox's web desktop URL (mirrors `box desktop`).
  // Sandboxes are headless by default; only templates that expose a desktop
  // port (e.g. `miosa-sandbox` w/ Kasm) emit a `preview_url`. We surface that.
  sandbox
    .command("desktop <sandbox-id>")
    .description(
      "Print the Sandbox's web desktop URL (when the template exposes one)",
    )
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        if (opts.json) {
          await getAndPrint(`/sandboxes/${enc(id)}`, opts);
          return;
        }
        const sb = (await getAndPrint(`/sandboxes/${enc(id)}`, {
          json: true,
        })) as unknown as { preview_url?: string };
        if (sb?.preview_url) {
          console.log(sb.preview_url);
        } else {
          console.error(
            chalk.yellow(
              "No desktop URL on this Sandbox. Use `miosa desktop open <computer-id>` for Computers, or expose a port via `miosa sandbox` for headless previews.",
            ),
          );
          process.exitCode = 1;
        }
      }),
    );

  // prompt — invoke an in-Sandbox AI agent CLI (mirrors `box prompt`).
  // Implemented as `exec claude/codex/claude-code <instruction>`.
  sandbox
    .command("prompt <sandbox-id> <instruction...>")
    .description(
      "Run an in-Sandbox AI agent (claude/codex) with the given instruction",
    )
    .option(
      "--provider <name>",
      "AI provider: claude (default), codex, claude-code",
    )
    .option("--model <name>", "Provider-specific model name")
    .option("--cwd <path>", "Working directory inside the Sandbox")
    .option("--timeout <sec>", "Exec timeout in seconds", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: {
          provider?: string;
          model?: string;
          cwd?: string;
          timeout?: number;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          const provider = opts.provider ?? "claude";
          const allowedProviders = ["claude", "codex", "claude-code"];
          if (!allowedProviders.includes(provider)) {
            throw new Error(
              `Unsupported provider "${provider}". Use: ${allowedProviders.join(", ")}`,
            );
          }
          const instruction = words.join(" ");
          const modelFlag = opts.model
            ? ` --model ${`'${opts.model.replace(/'/g, "'\\''")}'`}`
            : "";
          const command = commandInCwd(
            `${provider}${modelFlag} ${shellQuote(instruction)}`,
            opts.cwd,
          );
          const body: Record<string, unknown> = { command };
          if (opts.cwd) {
            body["cwd"] = opts.cwd;
            body["dir"] = opts.cwd;
          }
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, body);
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
      .option("--workdir <path>", "Alias for --cwd")
      .option("--env <pair>", "Environment variable KEY=VALUE. Repeatable.", collectOption, [])
      .option("--background", "Start the command in the background and return immediately")
      .option("--detached", "Create a durable backend command and return command_id immediately")
      .option("--user <user>", "Run command as user")
      .option("--sudo", "Run command through sudo")
      .option("--tty", "Request TTY metadata for command resource")
      .option("--interactive", "Request interactive metadata for command resource")
      .option("--timeout <sec>", "Exec timeout in seconds", parseIntegerOption),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: DataOptions & {
          cwd?: string;
          workdir?: string;
          env?: string[];
          background?: boolean;
          detached?: boolean;
          user?: string;
          sudo?: boolean;
          tty?: boolean;
          interactive?: boolean;
          timeout?: number;
        },
      ) =>
        runAction(async () => {
          if (opts.data) {
            await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, {});
            return;
          }
          const cmd = words.join(" ");
          const effectiveCommand = opts.background ? backgroundCommand(cmd) : cmd;
          const cwd = opts.cwd ?? opts.workdir;
          const body: Record<string, unknown> = cmd
            ? { command: commandInCwd(effectiveCommand, cwd) }
            : {};
          if (cwd) {
            body["cwd"] = cwd;
            body["dir"] = cwd;
          }
          const env = parseEnvPairs(opts.env ?? []);
          if (opts.detached) {
            const result = await createSandboxCommand(id, cmd, {
              cwd,
              env,
              user: opts.user,
              sudo: !!opts.sudo,
              tty: !!opts.tty,
              interactive: !!opts.interactive,
              timeout: opts.timeout,
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(String(result["id"] ?? result["command_id"] ?? ""));
            return;
          }
          if (Object.keys(env).length > 0) body["env"] = env;
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
      .option("--workdir <path>", "Alias for --cwd")
      .option("--env <pair>", "Environment variable KEY=VALUE. Repeatable.", collectOption, [])
      .option("--background", "Start the command in the background and return immediately")
      .option("--detached", "Create a durable backend command and return command_id immediately")
      .option("--user <user>", "Run command as user")
      .option("--sudo", "Run command through sudo")
      .option("--tty", "Request TTY metadata for command resource")
      .option("--interactive", "Request interactive metadata for command resource")
      .option("--timeout <sec>", "Exec timeout in seconds", parseIntegerOption),
  )
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: DataOptions & {
          cwd?: string;
          workdir?: string;
          env?: string[];
          background?: boolean;
          detached?: boolean;
          user?: string;
          sudo?: boolean;
          tty?: boolean;
          interactive?: boolean;
          timeout?: number;
        },
      ) =>
        runAction(async () => {
          if (opts.data) {
            await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, {});
            return;
          }
          const cmd = words.join(" ");
          const effectiveCommand = opts.background ? backgroundCommand(cmd) : cmd;
          const cwd = opts.cwd ?? opts.workdir;
          const body: Record<string, unknown> = cmd
            ? { command: commandInCwd(effectiveCommand, cwd) }
            : {};
          if (cwd) {
            body["cwd"] = cwd;
            body["dir"] = cwd;
          }
          const env = parseEnvPairs(opts.env ?? []);
          if (opts.detached) {
            const result = await createSandboxCommand(id, cmd, {
              cwd,
              env,
              user: opts.user,
              sudo: !!opts.sudo,
              tty: !!opts.tty,
              interactive: !!opts.interactive,
              timeout: opts.timeout,
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(String(result["id"] ?? result["command_id"] ?? ""));
            return;
          }
          if (Object.keys(env).length > 0) body["env"] = env;
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, body);
        }),
    );

  sandbox
    .command("deploy [local-dir]")
    .description(
      "Upload an app directory, start it in a sandbox, expose a preview URL, and wait for readiness",
    )
    .option("--sandbox <id>", "Existing sandbox ID. Creates one when omitted")
    .option("--template <template>", "Template for new sandbox", "miosa-sandbox")
    .option("--name <name>", "Name for a new sandbox")
    .option("--port <port>", "Preview port", parseIntegerOption)
    .option("--publish-port <port>", "Alias for --port", parseIntegerOption)
    .option("--start <command>", "Start command to run inside /workspace")
    .option("--install-command <command>", "Install command to run before start")
    .option("--no-install", "Skip automatic dependency install")
    .option("--wait", "Wait until the public preview returns a good HTTP status")
    .option("--timeout <duration>", "Wait timeout, e.g. 180s or 3m", parseDurationSec, 180)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        localDir = ".",
        opts: {
          sandbox?: string;
          template?: string;
          name?: string;
          port?: number;
          publishPort?: number;
          start?: string;
          installCommand?: string;
          install?: boolean;
          wait?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result = await deploySandbox(localDir, opts);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Sandbox")}  ${result.sandbox_id}`);
          console.log(`  ${chalk.bold("Port")}     ${result.port}`);
          console.log(`  ${chalk.bold("Preview")}  ${chalk.cyan(result.preview_url)}`);
          console.log(
            `  ${chalk.bold("Ready")}    ${
              result.preview_ready ? chalk.green("yes") : chalk.yellow("not verified")
            }`,
          );
          console.log();
        }),
    );

  sandbox
    .command("preview <sandbox-id>")
    .description("Expose a sandbox port and optionally wait for the public preview to answer")
    .requiredOption("--port <port>", "Port inside the sandbox to expose", parseIntegerOption)
    .option("--wait", "Wait until the public URL returns a good HTTP status")
    .option("--timeout <sec>", "Wait timeout in seconds", parseDurationSec, 120)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          port: number;
          wait?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result = await previewSandbox(id, opts.port, {
            wait: !!opts.wait,
            timeout: opts.timeout,
            probePath: opts.probePath,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(result.url);
          if (!result.ready) {
            console.error(
              chalk.yellow(
                `Preview route created but not verified yet (${result.error ?? result.status ?? "pending"}).`,
              ),
            );
          }
        }),
    );

  sandbox
    .command("wait <sandbox-id>")
    .description("Wait for sandbox VM, internal app port, edge route, TLS, and public preview readiness")
    .requiredOption("--port <port>", "Port inside the sandbox to check", parseIntegerOption)
    .option("--url", "Print only the ready public preview URL")
    .option("--timeout <sec>", "Wait timeout in seconds", parseDurationSec, 120)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          port: number;
          url?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result = await waitSandboxReady(
            id,
            opts.port,
            opts.probePath,
            opts.timeout,
          );
          if (opts.url && result.url) {
            console.log(result.url);
            return;
          }
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green("Ready"));
          console.log(chalk.cyan(result.url));
        }),
    );

  sandbox
    .command("domain <sandbox-id> <port>")
    .description("Return the public preview domain/URL for a sandbox port")
    .option("--wait", "Wait until the public URL is externally ready")
    .option("--timeout <duration>", "Wait timeout", parseDurationSec, 120)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        portText: string,
        opts: { wait?: boolean; timeout: number; probePath: string; json?: boolean },
      ) =>
        runAction(async () => {
          const port = Number(portText);
          if (!Number.isInteger(port)) throw new UserError(`Invalid port: ${portText}`);
          const result = await previewSandbox(id, port, {
            wait: !!opts.wait,
            timeout: opts.timeout,
            probePath: opts.probePath,
          });
          const data = { port, ...result };
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
            return;
          }
          console.log(result.url);
        }),
    );

  sandbox
    .command("publish <sandbox-id>")
    .description("Publish a sandbox workspace to durable MIOSA Deploy hosting")
    .option("--path <path>", "Path inside the sandbox to publish", "/workspace")
    .option("--app <id>", "Existing app/deployment ID to publish a new release to")
    .option("--name <name>", "Name for a new durable app")
    .option("--slug <slug>", "Production slug for a new durable app")
    .option("--environment <name>", "Target environment label", "production")
    .option("--build-command <cmd>", "Build command to run before publishing")
    .option("--run-command <cmd>", "Run command for dynamic/server deployments")
    .option("--domain <domain>", "Custom domain to attach")
    .option("--database <mode>", "none, create:postgres, postgres, or existing:<db-id>")
    .option("--port <port>", "Runtime port for dynamic deployments", parseIntegerOption)
    .option("--wait", "Wait for the production URL to answer")
    .option("--timeout <duration>", "Wait timeout", parseDurationSec, 180)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          path: string;
          app?: string;
          name?: string;
          slug?: string;
          environment: string;
          buildCommand?: string;
          runCommand?: string;
          domain?: string;
          database?: string;
          port?: number;
          wait?: boolean;
          timeout: number;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result = await publishSandbox(id, opts);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Type")}     deployment`);
          console.log(`  ${chalk.bold("App")}      ${result.deployment_id ?? result.app_id ?? ""}`);
          if (result.release_id) console.log(`  ${chalk.bold("Release")}  ${result.release_id}`);
          if (result.url) console.log(`  ${chalk.bold("URL")}      ${chalk.cyan(String(result.url))}`);
          console.log(`  ${chalk.bold("Ready")}    ${result.ready ? chalk.green("yes") : chalk.yellow("pending")}`);
          console.log();
        }),
    );

  const command = sandbox
    .command("command")
    .description("Inspect and control detached sandbox commands");

  command
    .command("get <sandbox-id> <command-id>")
    .option("--json", "Output as JSON")
    .action((id: string, commandId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/sandboxes/${enc(id)}/commands/${enc(commandId)}`, opts),
      ),
    );

  command
    .command("logs <sandbox-id> <command-id>")
    .option("--follow", "Follow logs (currently returns tailed logs when backend SSE is unavailable)")
    .option("--tail <n>", "Number of lines", parseIntegerOption, 200)
    .option("--json", "Output as JSON")
    .action(
      (id: string, commandId: string, opts: { follow?: boolean; tail: number; json?: boolean }) =>
        runAction(() =>
          getAndPrint(
            `/sandboxes/${enc(id)}/commands/${enc(commandId)}/logs?tail=${opts.tail}`,
            opts,
          ),
        ),
    );

  command
    .command("kill <sandbox-id> <command-id>")
    .option("--json", "Output as JSON")
    .action((id: string, commandId: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/sandboxes/${enc(id)}/commands/${enc(commandId)}/kill`,
          opts,
          {},
        ),
      ),
    );

  sandbox
    .command("extend <sandbox-id>")
    .description("Extend or replace a sandbox timeout")
    .requiredOption("--timeout <duration>", "New timeout, e.g. 2h", parseDurationSec)
    .option("--json", "Output as JSON")
    .action((id: string, opts: { timeout: number; json?: boolean }) =>
      runAction(() =>
        postAndPrint(`/sandboxes/${enc(id)}/extend`, opts, {
          timeout_sec: opts.timeout,
        }),
      ),
    );

  sandbox
    .command("usage <sandbox-id>")
    .description("Show sandbox runtime, rough resource usage, and estimated cost")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/sandboxes/${enc(id)}/usage`, opts)),
    );

  const config = sandbox
    .command("config")
    .description("Configure sandbox settings");

  config
    .command("network-policy <sandbox-id>")
    .description("Store egress network policy metadata for a sandbox")
    .option("--network-policy <policy>", "Network policy: allow-all or deny-all")
    .option("--allowed-domain <domain>", "Allowed egress domain. Repeatable.", collectOption, [])
    .option("--allowed-cidr <cidr>", "Allowed egress CIDR. Repeatable.", collectOption, [])
    .option("--denied-cidr <cidr>", "Denied egress CIDR. Repeatable.", collectOption, [])
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          networkPolicy?: string;
          allowedDomain?: string[];
          allowedCidr?: string[];
          deniedCidr?: string[];
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const policy = buildNetworkPolicy(opts);
          if (!policy) throw new UserError("No network policy options provided.");
          const result = unwrap(await client().apiPatch<unknown>(apiPath(`/sandboxes/${enc(id)}`), {
            metadata: { network_policy: policy },
          }));
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green("Network policy updated."));
        }),
    );

  const service = sandbox
    .command("service")
    .description("Manage named long-running processes inside a sandbox");

  service
    .command("start <sandbox-id> <name>")
    .requiredOption("--cmd <command>", "Command to start")
    .option("--cwd <path>", "Working directory inside the sandbox", "/workspace")
    .option("--port <port>", "Port served by this service", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (id: string, name: string, opts: { cmd: string; cwd: string; port?: number; json?: boolean }) =>
        runAction(async () => {
          const result = await startSandboxService(id, name, opts);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green(`Started ${name}`));
          if (result.preview_url) console.log(chalk.cyan(String(result.preview_url)));
        }),
    );

  service
    .command("restart <sandbox-id> <name>")
    .option("--cmd <command>", "Ignored when backend service metadata already exists")
    .option("--cwd <path>", "Working directory inside the sandbox", "/workspace")
    .option("--port <port>", "Port served by this service", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (id: string, name: string, opts: { cmd: string; cwd: string; port?: number; json?: boolean }) =>
        runAction(async () => {
          const result = unwrap(
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/services/${enc(name)}/restart`),
              {},
            ),
          ) as Record<string, unknown>;
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green(`Restarted ${name}`));
          if (result.preview_url) console.log(chalk.cyan(String(result.preview_url)));
        }),
    );

  service
    .command("status <sandbox-id> <name>")
    .option("--json", "Output as JSON")
    .action((id: string, name: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/sandboxes/${enc(id)}/services/${enc(name)}`),
          ),
        ) as Record<string, unknown>;
        const status = String(result["status"] ?? "unknown");
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(status === "running" ? chalk.green(status) : chalk.yellow(status));
      }),
    );

  service
    .command("logs <sandbox-id> <name>")
    .option("--lines <n>", "Number of log lines", parseIntegerOption, 100)
    .option("--json", "Output as JSON")
    .action((id: string, name: string, opts: { lines: number; json?: boolean }) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiGet<unknown>(
            apiPath(
              `/sandboxes/${enc(id)}/services/${enc(name)}/logs?tail=${Number(opts.lines) || 100}`,
            ),
          ),
        ) as Record<string, unknown>;
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const lines = Array.isArray(result["lines"]) ? result["lines"] : [];
        process.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
      }),
    );

  sandbox
    .command("doctor <sandbox-id>")
    .description(
      "Diagnose sandbox app readiness across sandbox state, internal HTTP, public route, and TLS/edge reachability",
    )
    .requiredOption("--port <port>", "Port inside the sandbox to check", parseIntegerOption)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: { port: number; probePath: string; json?: boolean },
      ) =>
        runAction(async () => {
          const report = await doctorSandbox(id, opts.port, opts.probePath);
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          renderDoctorReport(report);
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
          const result = await fetchApiRaw(
            apiPath(`/sandboxes/${enc(id)}/files`),
            { path: remotePath, content: base64 },
          );
          if (!opts.json) {
            console.log(chalk.green(`Written to ${remotePath}`));
          } else {
            printValue(typeof result === "string" ? { content: result } : result, opts);
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
        const result = await fetchApiRaw(
          apiPath(`/sandboxes/${enc(id)}/files/read?path=${enc(remotePath)}`),
        );
        if (opts.json) {
          console.log(
            JSON.stringify(
              typeof result === "string" ? { content: result } : result,
              null,
              2,
            ),
          );
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
          process.stdout.write(contentVal);
        } else if (typeof data === "string") {
          process.stdout.write(data);
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

  sandbox
    .command("upload-dir <sandbox-id> <local-dir> <remote-dir>")
    .description("Upload a local directory into a Sandbox")
    .option("--delete", "Delete the remote directory contents before extracting")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        localDir: string,
        remoteDir: string,
        opts: { delete?: boolean; json?: boolean },
      ) => {
        try {
          const result = await uploadDirToSandbox(id, localDir, remoteDir, {
            delete: !!opts.delete,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(
            chalk.green(`Uploaded ${result.files_label} → ${remoteDir}`),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  sandbox
    .command("sync <local-dir> <remote-dir>")
    .description("Sync a local directory into a sandbox")
    .requiredOption("--sandbox <id>", "Sandbox ID")
    .option("--delete", "Delete the remote directory contents before extracting")
    .option("--json", "Output as JSON")
    .action(
      async (
        localDir: string,
        remoteDir: string,
        opts: { sandbox: string; delete?: boolean; json?: boolean },
      ) => {
        try {
          const result = await uploadDirToSandbox(opts.sandbox, localDir, remoteDir, {
            delete: !!opts.delete,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green(`Synced ${result.files_label} → ${remoteDir}`));
        } catch (err) {
          handleError(err);
        }
      },
    );

  sandbox
    .command("cp <source> <target>")
    .alias("copy")
    .description("Copy a local file or directory into a sandbox, e.g. ./app/. sbx_123:/workspace")
    .option("--delete", "Delete the remote directory contents before extracting directories")
    .option("--json", "Output as JSON")
    .action(
      async (
        source: string,
        target: string,
        opts: { delete?: boolean; json?: boolean },
      ) => {
        try {
          if (isSandboxTarget(source) && !isSandboxTarget(target)) {
            const parsedSource = parseSandboxTarget(source);
            const result = await downloadSandboxPath(
              parsedSource.sandboxId,
              parsedSource.remotePath,
              target,
            );
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(chalk.green(`Copied ${source} → ${target}`));
            return;
          }

          if (isSandboxTarget(source) || !isSandboxTarget(target)) {
            throw new UserError(
              "Invalid copy direction.",
              "Use local → sandbox (`./app/. sbx_123:/workspace`) or sandbox → local (`sbx_123:/workspace/dist ./dist`).",
            );
          }

          const parsed = parseSandboxTarget(target);
          const local = source.endsWith("/.") ? source.slice(0, -2) : source;
          const stat = fs.statSync(local);
          if (stat.isDirectory()) {
            const result = await uploadDirToSandbox(
              parsed.sandboxId,
              local,
              parsed.remotePath,
              { delete: !!opts.delete },
            );
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              chalk.green(`Copied ${result.files_label} → ${target}`),
            );
            return;
          }
          const c = client();
          await uploadFileToSandbox(c, parsed.sandboxId, local, parsed.remotePath);
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  sandbox_id: parsed.sandboxId,
                  local_path: path.resolve(local),
                  remote_path: parsed.remotePath,
                },
                null,
                2,
              ),
            );
            return;
          }
          console.log(chalk.green(`Copied ${path.basename(local)} → ${target}`));
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
    .option("--lines <n>", "Number of log lines to fetch", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action((id: string, opts: { lines?: number } & JsonOptions) =>
      runAction(async () => {
        const qs = opts.lines != null ? `?lines=${opts.lines}` : "";
        await getAndPrint(`/sandboxes/${enc(id)}/logs${qs}`, opts);
      }),
    );

  // ssh — WS tunnel → local listener → spawn system ssh client
  sandbox
    .command("ssh <sandbox-id>")
    .description(
      "Open an SSH session into a running Sandbox via the platform WS tunnel",
    )
    .option("-p, --port <n>", "Local port for the tunnel listener", parseIntegerOption)
    .option("-l, --user <name>", "SSH user (default: root)")
    .option(
      "--no-spawn",
      "Print connection info instead of spawning the ssh client",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        opts: {
          port?: number;
          user?: string;
          spawn?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          await runSandboxSsh(id, opts);
        } catch (err) {
          handleError(err);
        }
      },
    );

  sandbox
    .command("shell <sandbox-id>")
    .description("Open an interactive shell into a running Sandbox")
    .option("-p, --port <n>", "Local port for the tunnel listener", parseIntegerOption)
    .option("-l, --user <name>", "SSH user (default: root)")
    .option("--json", "Output connection info as JSON")
    .action(
      async (
        id: string,
        opts: { port?: number; user?: string; json?: boolean },
      ) => {
        try {
          await runSandboxSsh(id, { ...opts, spawn: !opts.json });
        } catch (err) {
          handleError(err);
        }
      },
    );

  // port-forward — TCP listener → WS tunnel → sandbox port
  sandbox
    .command("port-forward <sandbox-id>")
    .alias("forward")
    .description(
      [
        "Forward a local TCP port to a port inside a Sandbox via the platform WS tunnel.",
        "",
        "Examples:",
        "  miosa sandbox port-forward sbx_123 --remote 5173",
        "  miosa sandbox port-forward sbx_123 --remote 5432 --local 15432",
      ].join("\n"),
    )
    .requiredOption(
      "--remote <port>",
      "Port inside the sandbox to reach",
      parseIntegerOption,
    )
    .option(
      "--local <port>",
      "Local port to listen on (default = remote port)",
      parseIntegerOption,
    )
    .option("--wait", "Probe the local forwarded URL before returning readiness")
    .option("--timeout <sec>", "Wait timeout in seconds", parseDurationSec, 30)
    .option("--probe-path <path>", "HTTP path to probe when --wait is set", "/")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        opts: {
          remote: number;
          local?: number;
          wait?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) => {
        try {
          await runSandboxPortForward(id, {
            remotePort: opts.remote,
            localPort: opts.local ?? opts.remote,
            wait: !!opts.wait,
            timeoutSec: opts.timeout,
            probePath: opts.probePath,
            json: !!opts.json,
          });
        } catch (err) {
          handleError(err);
        }
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

  sandbox
    .command("snapshot <sandbox-id>")
    .description("Create a Sandbox snapshot")
    .option("--name <name>", "Human-readable snapshot name/comment")
    .option("--comment <comment>", "Snapshot comment")
    .option("--stop", "Pause the sandbox after snapshot creation")
    .option("--expiration <duration>", "Requested retention duration, e.g. 14d")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          name?: string;
          comment?: string;
          stop?: boolean;
          expiration?: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const body: Record<string, unknown> = {};
          const comment = opts.comment ?? opts.name;
          if (comment) body["comment"] = comment;
          if (opts.expiration) body["expiration"] = opts.expiration;
          const snapshot = unwrap(
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/snapshots`),
              body,
            ),
          );
          if (opts.stop) {
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/pause`),
              {},
            );
          }
          if (opts.json) {
            console.log(
              JSON.stringify(
                { snapshot, stopped: !!opts.stop },
                null,
                2,
              ),
            );
            return;
          }
          const snap = (snapshot ?? {}) as Record<string, unknown>;
          console.log(chalk.green("Snapshot requested"));
          if (snap["id"]) console.log(String(snap["id"]));
          if (opts.stop) console.log(chalk.dim("Sandbox pause requested."));
        }),
    );

  const snapshots = sandbox
    .command("snapshots")
    .description("List, inspect, and delete Sandbox snapshots");

  snapshots
    .command("list <sandbox-id>")
    .description("List snapshots for a sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/sandboxes/${enc(id)}/snapshots`, opts),
      ),
    );

  snapshots
    .command("get <sandbox-id> <snapshot-id>")
    .description("Get a sandbox snapshot")
    .option("--json", "Output as JSON")
    .action((id: string, snapshotId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(
          `/sandboxes/${enc(id)}/snapshots/${enc(snapshotId)}`,
          opts,
        ),
      ),
    );

  snapshots
    .command("delete <sandbox-id> <snapshot-id>")
    .alias("rm")
    .description("Delete a sandbox snapshot")
    .option("--json", "Output as JSON")
    .action((id: string, snapshotId: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/sandboxes/${enc(id)}/snapshots/${enc(snapshotId)}`,
          opts,
        ),
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

// ── sandbox ssh implementation ─────────────────────────────────────────────
//
// Protocol:
//   1. Ensure the user has an SSH keypair at ~/.ssh/miosa_sandbox_ed25519.
//      If not, generate one and register it via POST /sandboxes/:id/ssh-keys.
//   2. Open a local TCP server on a random (or chosen) port.
//   3. Each accepted connection is bridged bidirectionally to the platform WS
//      endpoint wss://<api>/api/v1/sandboxes/:id/ssh-tunnel.
//   4. Spawn `ssh` pointing at localhost:<port> with the key and user.
//   5. On ssh exit, close the TCP server and exit.

const SANDBOX_KEY_PATH = path.join(
  os.homedir(),
  ".ssh",
  "miosa_sandbox_ed25519",
);

async function ensureSandboxSshKey(
  id: string,
  apiKey: string,
  endpoint: string,
): Promise<void> {
  if (fs.existsSync(SANDBOX_KEY_PATH)) return;

  console.log(chalk.dim("Generating SSH keypair for MIOSA sandbox access..."));
  fs.mkdirSync(path.join(os.homedir(), ".ssh"), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ssh-keygen",
      [
        "-t",
        "ed25519",
        "-f",
        SANDBOX_KEY_PATH,
        "-N",
        "",
        "-C",
        "miosa-sandbox",
      ],
      { stdio: "pipe" },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ssh-keygen exited with code ${code}`));
    });
    child.on("error", reject);
  });

  // Register the public key with the sandbox
  const pubKey = fs.readFileSync(`${SANDBOX_KEY_PATH}.pub`, "utf8").trim();
  const base = endpoint.replace(/\/$/, "");
  const res = await fetch(
    `${base}/api/v1/sandboxes/${encodeURIComponent(id)}/ssh-keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ public_key: pubKey }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to register SSH key: ${res.status} ${body}`);
  }

  console.log(chalk.green("SSH key registered."));
}

function bridgeSandboxWs(socket: Socket, wsUrl: string, apiKey: string): void {
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.destroy();
  }

  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  ws.on("open", () => {
    socket.on("data", (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    socket.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    socket.on("error", () => ws.close());
  });

  ws.on("message", (data: Buffer | string) => {
    if (!socket.destroyed) {
      socket.write(typeof data === "string" ? Buffer.from(data) : data);
    }
  });

  ws.on("close", cleanup);
  ws.on("error", (err) => {
    process.stderr.write(`\r\nWS error for sandbox tunnel: ${err.message}\r\n`);
    cleanup();
  });
}

async function runSandboxSsh(
  id: string,
  opts: { port?: number; user?: string; spawn?: boolean; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const apiKey = config.api_key;
  if (!apiKey) throw new Error("Not authenticated. Run: miosa login");

  const endpoint = config.endpoint ?? "https://api.miosa.ai";
  const base = endpoint.replace(/\/$/, "");
  const wsBase = base.replace(/^https?/, (p) => (p === "https" ? "wss" : "ws"));
  const wsUrl = `${wsBase}/api/v1/sandboxes/${encodeURIComponent(id)}/ssh-tunnel`;

  await ensureSandboxSshKey(id, String(apiKey), endpoint);

  // Pick a free local port
  const localPort = opts.port ?? (await pickFreePort());
  const user = opts.user ?? "root";

  if (opts.json) {
    console.log(
      JSON.stringify({
        sandbox_id: id,
        local_port: localPort,
        user,
        ws_url: wsUrl,
        key_path: SANDBOX_KEY_PATH,
      }),
    );
    return;
  }

  const server = createServer((socket) => {
    bridgeSandboxWs(socket, wsUrl, String(apiKey));
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(localPort, "127.0.0.1", resolve);
  });

  console.log(
    chalk.green("Tunnel ready.") +
      chalk.dim(` 127.0.0.1:${localPort} → sandbox ${id}`),
  );

  if (opts.spawn === false) {
    console.log(
      chalk.dim(
        `Connect manually: ssh -i ${SANDBOX_KEY_PATH} -p ${localPort} ${user}@127.0.0.1`,
      ),
    );
    console.log(chalk.dim("Press Ctrl+C to close."));
    await waitForSignal();
    server.close();
    return;
  }

  const sshArgs = [
    "-i",
    SANDBOX_KEY_PATH,
    "-p",
    String(localPort),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    `${user}@127.0.0.1`,
  ];

  const sshProc = spawn("ssh", sshArgs, { stdio: "inherit" });

  const exitCode = await new Promise<number>((resolve) => {
    sshProc.on("close", (code) => resolve(code ?? 1));
    sshProc.on("error", (err) => {
      console.error(chalk.red(`Failed to spawn ssh: ${err.message}`));
      resolve(1);
    });
  });

  server.close();
  process.exit(exitCode);
}

// ── sandbox port-forward implementation ───────────────────────────────────

interface PortForwardOptions {
  remotePort: number;
  localPort: number;
  wait: boolean;
  timeoutSec: number;
  probePath: string;
  json: boolean;
}

async function runSandboxPortForward(
  id: string,
  opts: PortForwardOptions,
): Promise<void> {
  const preview = await previewSandbox(id, opts.remotePort, {
    wait: true,
    timeout: opts.timeoutSec,
    probePath: opts.probePath,
  });
  const upstreamBase = new URL(preview.url);

  interface ConnStats {
    active: number;
    total: number;
    bytesIn: number;
    bytesOut: number;
  }
  const stats: ConnStats = { active: 0, total: 0, bytesIn: 0, bytesOut: 0 };

  const server = http.createServer((req, res) => {
    stats.active++;
    stats.total++;
    const target = new URL(req.url ?? "/", upstreamBase);
    const headers = { ...req.headers, host: target.host };
    const mod = target.protocol === "https:" ? https : http;
    const proxyReq = mod.request(
      target,
      { method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.on("data", (chunk: Buffer) => {
          stats.bytesOut += chunk.length;
        });
        proxyRes.pipe(res);
      },
    );
    req.on("data", (chunk: Buffer) => {
      stats.bytesIn += chunk.length;
    });
    proxyReq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`MIOSA port-forward upstream error: ${err.message}`);
    });
    res.on("close", () => {
      stats.active = Math.max(0, stats.active - 1);
    });
    req.pipe(proxyReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${opts.localPort} is already in use. Choose another with --local.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(opts.localPort, "127.0.0.1", resolve);
  });

  let localProbe: ProbeResult | null = null;
  if (opts.wait) {
    localProbe = await waitForLocalHttp(
      opts.localPort,
      opts.probePath,
      opts.timeoutSec,
    );
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        sandbox_id: id,
        remote_port: opts.remotePort,
        local_port: opts.localPort,
        upstream_url: preview.url,
        ready: localProbe?.ok ?? !opts.wait,
        status: localProbe?.status ?? null,
        latency_ms: localProbe?.latency_ms ?? null,
      }),
    );
  } else {
    console.log(
      `${chalk.green(opts.wait ? "Forwarding ready" : "Forwarding")} ${chalk.cyan(`localhost:${opts.localPort}`)} ${chalk.dim("→")} sandbox ${chalk.cyan(id)}:${chalk.bold(String(opts.remotePort))}`,
    );
    console.log(chalk.dim(`Upstream: ${preview.url}`));
    console.log(chalk.dim("Press Ctrl+C to close.\n"));
  }

  const ticker = setInterval(() => {
    if (opts.json || stats.active === 0) return;
    process.stderr.write(
      chalk.dim(
        `\r[${new Date().toLocaleTimeString()}] connections: ${stats.active}  ↑ ${formatBytes(stats.bytesIn)}  ↓ ${formatBytes(stats.bytesOut)}  `,
      ),
    );
  }, 5_000);

  await waitForSignal();
  clearInterval(ticker);
  process.stderr.write("\n");
  server.close();
}

// ── sandbox deploy / doctor implementation ─────────────────────────────────

interface SandboxDeployOptions {
  sandbox?: string;
  template?: string;
  name?: string;
  port?: number;
  publishPort?: number;
  start?: string;
  installCommand?: string;
  install?: boolean;
  wait?: boolean;
  timeout: number;
  probePath: string;
  json?: boolean;
}

interface SandboxDeployResult {
  sandbox_id: string;
  port: number;
  preview_url: string;
  preview_ready: boolean;
  internal_status?: number | null;
  edge_status?: number | null;
  latency_ms?: number | null;
  process_pid?: string | null;
}

interface SandboxPublishOptions {
  path: string;
  app?: string;
  name?: string;
  slug?: string;
  environment: string;
  buildCommand?: string;
  runCommand?: string;
  domain?: string;
  database?: string;
  port?: number;
  wait?: boolean;
  timeout: number;
  json?: boolean;
}

interface SandboxPublishResult {
  type: "deployment";
  sandbox_id: string;
  deployment_id: string | null;
  app_id: string | null;
  release_id: string | null;
  version_id: string | null;
  url: string | null;
  state: string | null;
  ready: boolean;
  probe?: ProbeResult | null;
  data: unknown;
}

interface ProbeResult {
  ok: boolean;
  status: number | null;
  latency_ms?: number | null;
  error?: string;
}

interface PreviewResult {
  url: string;
  ready: boolean;
  status: number | null;
  latency_ms: number | null;
  error?: string;
}

async function showSandboxWithPreview(
  sandboxId: string,
  port: number,
  probePath: string,
): Promise<Record<string, unknown>> {
  const c = client();
  const sandbox = unwrap(
    await c.apiGet<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}`)),
  ) as Record<string, unknown>;
  let preview: PreviewResult | null = null;
  try {
    preview = await previewSandbox(sandboxId, port, {
      wait: false,
      timeout: 1,
      probePath,
    });
  } catch (err) {
    preview = {
      url: "",
      ready: false,
      status: null,
      latency_ms: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    ...sandbox,
    ready: preview?.ready ?? false,
    preview: {
      url: preview?.url || null,
      port,
      route_ready: Boolean(preview?.url),
      tls_ready: preview?.ready ?? false,
      last_status: preview?.status ?? null,
      latency_ms: preview?.latency_ms ?? null,
      error: preview?.error,
    },
  };
}

async function previewSandbox(
  sandboxId: string,
  port: number,
  opts: { wait: boolean; timeout: number; probePath: string },
): Promise<PreviewResult> {
  const c = client();
  const exposed = unwrap(
    await c.apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/expose`), {
      port,
      title: "app preview",
    }),
  );
  const url = extractUrl(exposed);
  if (!url) throw new UserError("Sandbox expose did not return a preview URL.");

  const edge = opts.wait
    ? await waitForPublicPreview(url, opts.probePath, opts.timeout)
    : await probePublicPreview(url, opts.probePath);

  return {
    url,
    ready: edge.ok,
    status: edge.status,
    latency_ms: edge.latency_ms ?? null,
    error: edge.error,
  };
}

async function waitSandboxReady(
  sandboxId: string,
  port: number,
  probePath: string,
  timeoutSec: number,
): Promise<PreviewResult & { sandbox_id: string; port: number; internal_status: number | null }> {
  const c = client();
  await waitForSandboxRunning(c, sandboxId, Math.min(timeoutSec, 120));
  const internal = await waitForInternalHttp(
    c,
    sandboxId,
    port,
    probePath,
    Math.min(timeoutSec, 60),
  );
  const preview = await previewSandbox(sandboxId, port, {
    wait: true,
    timeout: timeoutSec,
    probePath,
  });
  return {
    sandbox_id: sandboxId,
    port,
    internal_status: internal.status,
    ...preview,
  };
}

async function startSandboxService(
  sandboxId: string,
  name: string,
  opts: { cmd: string; cwd: string; port?: number },
): Promise<Record<string, unknown>> {
  validateServiceName(name);
  const result = unwrap(
    await client().apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/services`), {
      name,
      command: opts.cmd,
      cwd: opts.cwd,
    }),
  ) as Record<string, unknown>;

  let previewUrl: string | null = null;
  if (opts.port != null) {
    const preview = await previewSandbox(sandboxId, opts.port, {
      wait: false,
      timeout: 1,
      probePath: "/",
    });
    previewUrl = preview.url;
  }
  return {
    ...result,
    port: opts.port ?? null,
    preview_url: previewUrl,
  };
}

async function createSandboxCommand(
  sandboxId: string,
  command: string,
  opts: {
    cwd?: string;
    env: Record<string, string>;
    user?: string;
    sudo: boolean;
    tty: boolean;
    interactive: boolean;
    timeout?: number;
  },
): Promise<Record<string, unknown>> {
  if (!command.trim()) throw new UserError("Command is required.");
  const result = unwrap(
    await client().apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/commands`), {
      command,
      cwd: opts.cwd,
      env: opts.env,
      user: opts.user,
      sudo: opts.sudo,
      tty: opts.tty,
      interactive: opts.interactive,
      timeout: opts.timeout,
    }),
  ) as Record<string, unknown>;
  return {
    ...result,
    command_id: result["id"],
    status: result["status"] ?? "running",
  };
}

function serviceLogPath(name: string): string {
  return `/tmp/miosa-services/${name}.log`;
}

function servicePidPath(name: string): string {
  return `/tmp/miosa-services/${name}.pid`;
}

function validateServiceName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new UserError(
      `Invalid service name: ${name}`,
      "Use only letters, numbers, dot, dash, and underscore.",
    );
  }
}

async function deploySandbox(
  localDir: string,
  opts: SandboxDeployOptions,
): Promise<SandboxDeployResult> {
  const sourceDir = path.resolve(localDir);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new UserError(`Local directory not found: ${sourceDir}`);
  }

  const c = client();
  const detection = detectFramework(sourceDir);
  const port = opts.port ?? opts.publishPort ?? detection?.port ?? 5173;
  const start = opts.start ?? defaultStartCommand(detection?.framework, port);
  const installCommand =
    opts.install === false
      ? null
      : opts.installCommand ?? defaultInstallCommand(sourceDir);

  const sandboxId =
    opts.sandbox ??
    (deployStep(opts, "Creating sandbox"),
    await createSandboxForDeploy(c, opts.template ?? "miosa-sandbox", opts.name));

  deployStep(opts, "Waiting for sandbox");
  await waitForSandboxRunning(c, sandboxId, Math.min(opts.timeout, 120));

  deployStep(opts, "Uploading files");
  const archivePath = createDeployArchive(sourceDir);
  const remoteArchive = `/tmp/miosa-deploy-${Date.now()}.tgz`;
  try {
    await uploadFileToSandbox(c, sandboxId, archivePath, remoteArchive);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  deployStep(opts, "Extracting workspace");
  await execSandbox(c, sandboxId, `mkdir -p /workspace && tar -xzf ${shellQuote(remoteArchive)} -C /workspace`, "/");

  if (installCommand) {
    deployStep(opts, `Installing dependencies: ${installCommand}`);
    await execSandbox(c, sandboxId, installCommand, "/workspace", opts.timeout);
  }

  deployStep(opts, `Starting app on port ${port}`);
  await execSandbox(
    c,
    sandboxId,
    `fuser -k ${port}/tcp >/dev/null 2>&1 || true; nohup sh -lc ${shellQuote(start)} > ${shellQuote(`/tmp/miosa-app-${port}.log`)} 2>&1 & echo $!`,
    "/workspace",
  );

  deployStep(opts, "Checking internal app readiness");
  const internal = await waitForInternalHttp(c, sandboxId, port, opts.probePath, Math.min(opts.timeout, 60));
  deployStep(opts, "Creating public preview route");
  const exposed = await c.apiPost<unknown>(
    apiPath(`/sandboxes/${enc(sandboxId)}/expose`),
    { port, title: "app preview" },
  );
  const previewUrl = extractUrl(unwrap(exposed));
  if (!previewUrl) {
    throw new UserError("Sandbox expose did not return a preview URL.");
  }

  if (opts.wait) deployStep(opts, "Checking public preview readiness");
  const edge = opts.wait
    ? await waitForPublicPreview(previewUrl, opts.probePath, opts.timeout)
    : { ok: false, status: null };

  return {
    sandbox_id: sandboxId,
    port,
    preview_url: previewUrl,
    preview_ready: edge.ok,
    internal_status: internal.status,
    edge_status: edge.status,
    latency_ms: edge.latency_ms ?? null,
  };
}

async function publishSandbox(
  sandboxId: string,
  opts: SandboxPublishOptions,
): Promise<SandboxPublishResult> {
  const c = client();
  const body: Record<string, unknown> = {
    output_path: opts.path,
    path: opts.path,
    environment: opts.environment,
    metadata: { environment: opts.environment },
  };
  if (opts.app) body["deployment_id"] = opts.app;
  if (opts.name) body["name"] = opts.name;
  if (opts.slug) body["slug"] = opts.slug;
  if (opts.buildCommand) body["build_command"] = opts.buildCommand;
  if (opts.runCommand) body["run_command"] = opts.runCommand;
  if (opts.domain) body["domain"] = opts.domain;
  if (opts.port != null) body["port"] = opts.port;

  const database = parsePublishDatabase(opts.database);
  if (database !== undefined) body["database"] = database;

  deployStep(opts, "Publishing sandbox workspace to durable deployment");
  const raw = unwrap(
    await c.apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/publish`),
      body,
    ),
  );
  const response = asRecord(raw) ?? {};
  const data = asRecord(response["data"]) ?? response;
  const deployment = asRecord(data["deployment"]);
  const version = asRecord(data["version"]);
  const release = asRecord(data["release"]);

  const deploymentId =
    stringField(response, "deployment_id") ??
    stringField(deployment, "id") ??
    null;
  const versionId =
    stringField(response, "version_id") ??
    stringField(version, "id") ??
    null;
  const releaseId =
    stringField(response, "release_id") ??
    stringField(release, "id") ??
    null;

  let state =
    stringField(response, "state") ??
    stringField(deployment, "state") ??
    null;
  let url =
    stringField(response, "url") ??
    extractUrl(deployment) ??
    stringField(data, "url") ??
    null;

  if (opts.wait && deploymentId) {
    deployStep(opts, "Waiting for durable deployment");
    const waited = await waitForDeploymentReady(c, deploymentId, opts.timeout);
    state = stringField(waited, "state") ?? state;
    url = extractUrl(waited) ?? url;
  }

  let probe: ProbeResult | null = null;
  if (opts.wait && url) {
    deployStep(opts, "Checking production URL readiness");
    probe = await waitForPublicPreview(url, "/", opts.timeout);
  }

  const ready =
    (state === null || ["running", "active"].includes(state.toLowerCase())) &&
    (opts.wait ? probe?.ok !== false : true);

  return {
    type: "deployment",
    sandbox_id: sandboxId,
    deployment_id: deploymentId,
    app_id: deploymentId,
    release_id: releaseId,
    version_id: versionId,
    url,
    state,
    ready,
    probe,
    data: raw,
  };
}

async function waitForDeploymentReady(
  c: ReturnType<typeof client>,
  deploymentId: string,
  timeoutSec: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: Record<string, unknown> | null = null;

  while (Date.now() < deadline) {
    const value = unwrap(
      await c.apiGet<unknown>(apiPath(`/deployments/${enc(deploymentId)}`)),
    );
    const deployment = asRecord(value) ?? {};
    last = deployment;
    const state = String(deployment["state"] ?? "").toLowerCase();
    if (state === "running" || state === "active") return deployment;
    if (state === "failed" || state === "error") {
      throw new UserError(
        `Deployment ${deploymentId} entered ${state} state.`,
        String(deployment["error_message"] ?? deployment["error"] ?? ""),
      );
    }
    await sleep(2000);
  }

  throw new UserError(
    `Deployment ${deploymentId} did not become ready within ${timeoutSec}s.`,
    last ? `Last state: ${String(last["state"] ?? "unknown")}` : undefined,
  );
}

function parsePublishDatabase(value?: string): unknown {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "none") return false;
  if (
    normalized === "postgres" ||
    normalized === "postgresql" ||
    normalized === "create:postgres" ||
    normalized === "create:postgresql"
  ) {
    return { engine: "postgresql", engine_version: "15" };
  }
  if (normalized.startsWith("existing:")) {
    return { existing_database_id: value.slice("existing:".length) };
  }
  return value;
}

function deployStep(opts: { json?: boolean }, label: string): void {
  if (!opts.json) console.error(chalk.dim(`→ ${label}`));
}

async function doctorSandbox(
  sandboxId: string,
  port: number,
  probePath: string,
): Promise<Record<string, unknown>> {
  const c = client();
  const sandbox = unwrap(
    await c.apiGet<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}`)),
  ) as Record<string, unknown>;
  const internal = await probeInternalHttp(c, sandboxId, port, probePath);
  let exposeData: Record<string, unknown> = {};
  try {
    exposeData = unwrap(
      await c.apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/expose`), {
        port,
        title: "doctor probe",
      }),
    ) as Record<string, unknown>;
  } catch (err) {
    exposeData = { error: err instanceof Error ? err.message : String(err) };
  }
  const previewUrl = extractUrl(exposeData);
  const edge = previewUrl
    ? await probePublicPreview(previewUrl, probePath)
    : { ok: false, status: null, error: "No preview URL returned" };

  return {
    sandbox_id: sandboxId,
    sandbox_state: sandbox["state"] ?? sandbox["status"] ?? "unknown",
    process: internal.ok ? "listening" : "not_ready",
    route: previewUrl ? "created" : "missing",
    tls: edge.error && /tls|certificate|ssl/i.test(edge.error) ? "not_ready" : previewUrl ? "checked" : "unknown",
    internal_probe: internal,
    edge_probe: edge,
    preview_ready: edge.ok,
    preview_url: previewUrl,
    expose: exposeData,
  };
}

function renderDoctorReport(report: Record<string, unknown>): void {
  console.log();
  console.log(chalk.bold("Sandbox Doctor"));
  console.log();
  console.log(`  ${chalk.bold("Sandbox")}       ${report["sandbox_id"]}`);
  console.log(`  ${chalk.bold("State")}         ${report["sandbox_state"]}`);
  console.log(`  ${chalk.bold("Process")}       ${report["process"]}`);
  console.log(`  ${chalk.bold("Route")}         ${report["route"]}`);
  console.log(`  ${chalk.bold("TLS/edge")}      ${report["tls"]}`);
  console.log(`  ${chalk.bold("Preview ready")} ${report["preview_ready"] ? chalk.green("yes") : chalk.red("no")}`);
  if (report["preview_url"]) {
    console.log(`  ${chalk.bold("Preview URL")}   ${chalk.cyan(String(report["preview_url"]))}`);
  }
  console.log();
  if (!report["preview_ready"]) {
    console.log(
      chalk.yellow(
        "  Preview is not externally ready yet. Internal app health and edge probe details are in --json output.",
      ),
    );
    console.log();
  }
}

async function createSandboxForDeploy(
  c: ReturnType<typeof client>,
  template: string,
  name?: string,
): Promise<string> {
  const body: Record<string, unknown> = { template_id: template };
  if (name) body["name"] = name;
  const created = unwrap(await c.apiPost<unknown>(apiPath("/sandboxes"), body)) as Record<string, unknown>;
  const sandboxId = typeof created["id"] === "string" ? created["id"] : "";
  if (!sandboxId) throw new UserError("Sandbox create did not return an id.");
  return sandboxId;
}

async function waitForSandboxRunning(
  c: ReturnType<typeof client>,
  sandboxId: string,
  timeoutSec: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const sandbox = unwrap(
      await c.apiGet<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}`)),
    ) as Record<string, unknown>;
    const state = String(sandbox["state"] ?? sandbox["status"] ?? "").toLowerCase();
    if (state === "running" || state === "active") return sandbox;
    if (state === "error" || state === "failed") {
      throw new UserError(`Sandbox ${sandboxId} entered ${state} state.`);
    }
    await sleep(1500);
  }
  throw new UserError(`Sandbox ${sandboxId} did not become running within ${timeoutSec}s.`);
}

function createDeployArchive(sourceDir: string): string {
  const archivePath = path.join(os.tmpdir(), `miosa-deploy-${process.pid}-${Date.now()}.tgz`);
  const result = spawnSync(
    "tar",
    [
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
      "--exclude",
      ".next",
      "--exclude",
      "dist",
      "--exclude",
      ".DS_Store",
      "--exclude",
      "._*",
      "--exclude",
      "__MACOSX",
      "-czf",
      archivePath,
      "-C",
      sourceDir,
      ".",
    ],
    { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  if (result.status !== 0) {
    throw new UserError(
      `Could not archive ${sourceDir}: ${result.stderr.toString().trim() || "tar failed"}`,
    );
  }
  return archivePath;
}

async function uploadFileToSandbox(
  c: ReturnType<typeof client>,
  sandboxId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await c.apiPost(apiPath(`/sandboxes/${enc(sandboxId)}/files`), {
    path: remotePath,
    content: fs.readFileSync(localPath).toString("base64"),
  });
}

async function uploadDirToSandbox(
  sandboxId: string,
  localDir: string,
  remoteDir: string,
  opts: { delete: boolean },
): Promise<{ sandbox_id: string; local_dir: string; remote_dir: string; files_label: string }> {
  const sourceDir = path.resolve(localDir);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new UserError(`Local directory not found: ${sourceDir}`);
  }
  const c = client();
  const archivePath = createDeployArchive(sourceDir);
  const remoteArchive = `/tmp/miosa-upload-${Date.now()}.tgz`;
  try {
    await uploadFileToSandbox(c, sandboxId, archivePath, remoteArchive);
    const clean = opts.delete
      ? `rm -rf ${shellQuote(remoteDir)} && mkdir -p ${shellQuote(remoteDir)}`
      : `mkdir -p ${shellQuote(remoteDir)}`;
    await execSandbox(
      c,
      sandboxId,
      `${clean} && tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteDir)} && rm -f ${shellQuote(remoteArchive)}`,
      "/",
    );
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  return {
    sandbox_id: sandboxId,
    local_dir: sourceDir,
    remote_dir: remoteDir,
    files_label: path.basename(sourceDir) || sourceDir,
  };
}

async function execSandbox(
  c: ReturnType<typeof client>,
  sandboxId: string,
  command: string,
  cwd?: string,
  timeout?: number,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { command: commandInCwd(command, cwd) };
  if (cwd) {
    body["cwd"] = cwd;
    body["dir"] = cwd;
  }
  if (timeout != null) body["timeout"] = timeout;
  const result = unwrap(
    await c.apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/exec`), body),
  ) as Record<string, unknown>;
  const exitCode = Number(result["exit_code"] ?? 0);
  if (exitCode !== 0) {
    throw new UserError(
      `Sandbox command failed with exit code ${exitCode}: ${command}`,
      String(result["stderr"] ?? result["stdout"] ?? ""),
    );
  }
  return result;
}

async function waitForInternalHttp(
  c: ReturnType<typeof client>,
  sandboxId: string,
  port: number,
  probePath: string,
  timeoutSec: number,
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: ProbeResult = { ok: false, status: null };
  while (Date.now() < deadline) {
    last = await probeInternalHttp(c, sandboxId, port, probePath);
    if (last.ok) return last;
    await sleep(1500);
  }
  throw new UserError(
    `App did not answer inside the sandbox on port ${port} within ${timeoutSec}s.`,
    last.error,
  );
}

async function probeInternalHttp(
  c: ReturnType<typeof client>,
  sandboxId: string,
  port: number,
  probePath: string,
): Promise<ProbeResult> {
  try {
    const result = await execSandbox(
      c,
      sandboxId,
      `python3 - <<'PY'\nimport urllib.request, sys\nurl = 'http://127.0.0.1:${port}${probePath.startsWith("/") ? probePath : `/${probePath}`}'\ntry:\n    r = urllib.request.urlopen(url, timeout=3)\n    print(r.status)\n    sys.exit(0 if 200 <= r.status < 400 else 1)\nexcept Exception as e:\n    print(e)\n    sys.exit(1)\nPY`,
      "/",
      10,
    );
    const status = Number(String(result["stdout"] ?? "").trim().split(/\s+/)[0]);
    return { ok: Number.isFinite(status) && status >= 200 && status < 400, status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForPublicPreview(
  previewUrl: string,
  probePath: string,
  timeoutSec: number,
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: ProbeResult = { ok: false, status: null };
  while (Date.now() < deadline) {
    last = await probePublicPreview(previewUrl, probePath);
    if (last.ok) return last;
    await sleep(2000);
  }
  throw new UserError(
    `Preview URL was created but did not become publicly ready within ${timeoutSec}s.`,
    last.error ?? (last.status ? `Last HTTP status: ${last.status}` : undefined),
  );
}

async function probePublicPreview(
  previewUrl: string,
  probePath: string,
): Promise<ProbeResult> {
  try {
    const url = new URL(previewUrl);
    url.pathname = joinUrlPath(url.pathname, probePath);
    const t0 = Date.now();
    const res = await fetch(url, { method: "GET", redirect: "manual" });
    return {
      ok: (res.status >= 200 && res.status < 400) || res.status === 401 || res.status === 403,
      status: res.status,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForLocalHttp(
  localPort: number,
  probePath: string,
  timeoutSec: number,
): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: ProbeResult = { ok: false, status: null };
  const url = `http://127.0.0.1:${localPort}${probePath.startsWith("/") ? probePath : `/${probePath}`}`;
  while (Date.now() < deadline) {
    last = await probePublicPreview(url, "/");
    if (last.ok) return last;
    await sleep(1000);
  }
  throw new UserError(
    `Local forwarded URL did not answer within ${timeoutSec}s.`,
    last.error ?? (last.status ? `Last HTTP status: ${last.status}` : undefined),
  );
}

function defaultInstallCommand(sourceDir: string): string | null {
  if (fs.existsSync(path.join(sourceDir, "package.json"))) return "npm install";
  if (fs.existsSync(path.join(sourceDir, "requirements.txt"))) return "pip install -r requirements.txt";
  return null;
}

function defaultStartCommand(framework: string | undefined, port: number): string {
  if (framework === "nextjs") return `npm run dev -- -H 0.0.0.0 -p ${port}`;
  if (framework === "vite-react") return `npm run dev -- --host 0.0.0.0 --port ${port}`;
  if (framework === "static") return `python3 -m http.server ${port} --bind 0.0.0.0`;
  return `npm run dev -- --host 0.0.0.0 --port ${port}`;
}

function extractUrl(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ["url", "preview_url", "public_url"]) {
    if (typeof row[key] === "string" && row[key]) return row[key];
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  row: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = row?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSandboxTarget(value: string): boolean {
  const idx = value.indexOf(":");
  if (idx <= 0) return false;
  return value.slice(idx + 1).startsWith("/");
}

function parseSandboxTarget(target: string): { sandboxId: string; remotePath: string } {
  const idx = target.indexOf(":");
  if (idx <= 0 || idx === target.length - 1) {
    throw new UserError(
      `Invalid sandbox target: ${target}`,
      "Use the form <sandbox-id>:/absolute/path",
    );
  }
  const sandboxId = target.slice(0, idx);
  const remotePath = target.slice(idx + 1);
  if (!remotePath.startsWith("/")) {
    throw new UserError(
      `Invalid remote path: ${remotePath}`,
      "Sandbox copy targets must use an absolute path, e.g. sbx_123:/workspace",
    );
  }
  return { sandboxId, remotePath };
}

async function downloadSandboxPath(
  sandboxId: string,
  remotePath: string,
  localTarget: string,
): Promise<Record<string, unknown>> {
  const c = client();
  const kind = await remotePathKind(c, sandboxId, remotePath);
  if (kind === "directory") {
    const remoteArchive = `/tmp/miosa-copy-${Date.now()}.tgz`;
    await execSandbox(
      c,
      sandboxId,
      `tar -czf ${shellQuote(remoteArchive)} -C ${shellQuote(remotePath)} .`,
      "/",
    );
    const archiveBytes = await readSandboxFile(c, sandboxId, remoteArchive);
    const localDir = path.resolve(localTarget);
    fs.mkdirSync(localDir, { recursive: true });
    const localArchive = path.join(os.tmpdir(), `miosa-copy-${process.pid}-${Date.now()}.tgz`);
    fs.writeFileSync(localArchive, archiveBytes);
    try {
      const result = spawnSync("tar", ["-xzf", localArchive, "-C", localDir], {
        stdio: "pipe",
      });
      if (result.status !== 0) {
        throw new UserError(
          `Could not extract ${remotePath}: ${result.stderr.toString().trim() || "tar failed"}`,
        );
      }
    } finally {
      fs.rmSync(localArchive, { force: true });
      await execSandbox(c, sandboxId, `rm -f ${shellQuote(remoteArchive)}`, "/").catch(() => ({}));
    }
    return {
      sandbox_id: sandboxId,
      remote_path: remotePath,
      local_path: localDir,
      type: "directory",
    };
  }

  const bytes = await readSandboxFile(c, sandboxId, remotePath);
  const localPath =
    fs.existsSync(localTarget) && fs.statSync(localTarget).isDirectory()
      ? path.join(localTarget, path.basename(remotePath))
      : localTarget;
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  fs.writeFileSync(localPath, bytes);
  return {
    sandbox_id: sandboxId,
    remote_path: remotePath,
    local_path: path.resolve(localPath),
    type: "file",
  };
}

async function remotePathKind(
  c: ReturnType<typeof client>,
  sandboxId: string,
  remotePath: string,
): Promise<"file" | "directory"> {
  const result = await execSandbox(
    c,
    sandboxId,
    `if [ -d ${shellQuote(remotePath)} ]; then echo directory; elif [ -f ${shellQuote(remotePath)} ]; then echo file; else exit 2; fi`,
    "/",
  );
  const kind = String(result["stdout"] ?? "").trim();
  if (kind === "directory") return "directory";
  return "file";
}

async function readSandboxFile(
  c: ReturnType<typeof client>,
  sandboxId: string,
  remotePath: string,
): Promise<Buffer> {
  const encoded = enc(remotePath.replace(/^\//, ""));
  const result = await c.apiGet<unknown>(
    apiPath(`/sandboxes/${enc(sandboxId)}/files/${encoded}`),
  );
  const data =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>)["content"] === "string"
  ) {
    return Buffer.from((data as Record<string, unknown>)["content"] as string, "base64");
  }
  throw new UserError(`Could not read sandbox file: ${remotePath}`);
}

async function fetchApiRaw(path: string, body?: unknown): Promise<unknown> {
  const config = loadConfig();
  const apiKey = config.api_key;
  if (!apiKey) throw new UserError("Not authenticated. Run: miosa login");

  const endpoint = (config.endpoint ?? "https://api.miosa.ai").replace(/\/$/, "");
  const res = await fetch(`${endpoint}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${String(apiKey)}`,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": "@miosa/cli",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new UserError(
      `Server error (${res.status}): HTTP ${res.status}`,
      text || res.statusText,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function commandInCwd(command: string, cwd?: string): string {
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

function backgroundCommand(command: string): string {
  if (!command.trim()) return command;
  const logPath = `/tmp/miosa-bg-${Date.now()}.log`;
  return `nohup sh -lc ${shellQuote(command)} > ${shellQuote(logPath)} 2>&1 & echo $!`;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw new UserError(
        `Invalid --env value: ${pair}`,
        "Use KEY=VALUE, for example --env DATABASE_URL=postgresql://...",
      );
    }
    env[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return env;
}

function parseDurationSec(value: string): number {
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) throw new UserError(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit === "ms") return Math.max(1, Math.ceil(amount / 1000));
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  if (unit === "h") return amount * 60 * 60;
  if (unit === "d") return amount * 24 * 60 * 60;
  return amount;
}

function parseIntegerOption(value: string): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n)) throw new UserError(`Invalid integer: ${value}`);
  return n;
}

function parseSizeMb(value: string): number {
  const match = String(value).trim().match(/^(\d+)(mb|m|gb|g)?$/i);
  if (!match) throw new UserError(`Invalid size: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "mb").toLowerCase();
  if (unit === "gb" || unit === "g") return amount * 1024;
  return amount;
}

function buildNetworkPolicy(opts: {
  networkPolicy?: string;
  allowedDomain?: string[];
  allowedCidr?: string[];
  deniedCidr?: string[];
}): Record<string, unknown> | null {
  const allowedDomains = opts.allowedDomain ?? [];
  const allowedCidrs = opts.allowedCidr ?? [];
  const deniedCidrs = opts.deniedCidr ?? [];
  if (
    !opts.networkPolicy &&
    allowedDomains.length === 0 &&
    allowedCidrs.length === 0 &&
    deniedCidrs.length === 0
  ) {
    return null;
  }
  return {
    mode: opts.networkPolicy ?? "allow-all",
    allowed_domains: allowedDomains,
    allowed_cidrs: allowedCidrs,
    denied_cidrs: deniedCidrs,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function joinUrlPath(basePath: string, probePath: string): string {
  const probe = probePath.startsWith("/") ? probePath : `/${probePath}`;
  if (!basePath || basePath === "/") return probe;
  return `${basePath.replace(/\/$/, "")}${probe}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── shared helpers ─────────────────────────────────────────────────────────

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Could not pick a free port"));
      });
    });
  });
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    function done(): void {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    }
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
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
