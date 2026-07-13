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
import {
  loadAppManifest,
  manifestPort,
  manifestProbePath,
  manifestStartCommand,
  parseAppManifest,
  type MiosaAppManifest,
} from "../app-manifest.js";
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
import { handleError, isJsonMode } from "./util.js";
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
import {
  ApiResponseError,
  MiosaError,
  NetworkError,
  ServerError,
  UserError,
  mapHttpError,
} from "../errors.js";
import { EXIT_USER_ERROR, type ApiErrorBody } from "../types.js";
import {
  registerSandboxDevCommands,
  runFullSandboxDoctor,
} from "./sandbox-dev.js";

const DEFAULT_INTERACTIVE_SANDBOX_TIMEOUT_SEC = 3_600;
const DEFAULT_CREATE_WAIT_TIMEOUT_SEC = 120;
const EXPIRING_SANDBOX_THRESHOLD_SEC = 5 * 60;

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

  registerSandboxDevCommands(sandbox);

  // list
  sandbox
    .command("list")
    .description("List all Sandboxes")
    .option("--state <state>", "Filter by state (running, paused, …)")
    .option("--json", "Output as JSON")
    .action((opts: { state?: string } & JsonOptions) =>
      runAction(async () => {
        const qs = opts.state ? `?state=${enc(opts.state)}` : "";

        if (isJsonMode(opts)) {
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
    .option(
      "--port <port>",
      "Include live preview readiness for this port",
      parseIntegerOption,
    )
    .option("--probe-path <path>", "HTTP path to probe when --port is set", "/")
    .option("--json", "Output as JSON")
    .action(
      (id: string, opts: JsonOptions & { port?: number; probePath: string }) =>
        runAction(async () => {
          if (isJsonMode(opts)) {
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
          warnIfExpiringSoon(sb, str(sb["id"]));
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
      .option(
        "--timeout <duration>",
        "Wall-clock timeout, e.g. 300s, 1h",
        parseDurationSec,
      )
      .option(
        "--publish-port <port>",
        "Expose this port after create",
        parseIntegerOption,
      )
      .option("--wait", "Wait for sandbox running and published port readiness")
      .option(
        "--probe-path <path>",
        "HTTP path to probe when --publish-port is set",
        "/",
      )
      .option(
        "--source <source>",
        "Source: git:https://..., tarball:https://..., or snapshot:<id>",
      )
      .option(
        "--revision <revision>",
        "Git revision/branch when --source git: is used",
      )
      .option(
        "--depth <n>",
        "Git clone depth when --source git: is used",
        parseIntegerOption,
      )
      .option("--snapshot <id>", "Create from a sandbox snapshot")
      .option("--workspace <id-or-slug>", "Workspace ID/slug")
      .option(
        "--external-workspace <id>",
        "White-label workspace/customer ID for billing attribution",
      )
      .option(
        "--external-user <id>",
        "White-label user ID for billing attribution",
      )
      .option(
        "--external-project <id>",
        "White-label project ID for billing attribution",
      )
      .option(
        "--agent-profile <id>",
        "Agent runtime profile ID to mount into the sandbox",
      )
      .option(
        "--skip-agent-profile",
        "Do not apply the tenant/workspace default agent runtime profile",
      )
      .option(
        "--network-policy <policy>",
        "Network policy: allow-all or deny-all",
      )
      .option(
        "--allowed-domain <domain>",
        "Allowed egress domain. Repeatable.",
        collectOption,
        [],
      )
      .option(
        "--allowed-cidr <cidr>",
        "Allowed egress CIDR. Repeatable.",
        collectOption,
        [],
      )
      .option(
        "--denied-cidr <cidr>",
        "Denied egress CIDR. Repeatable.",
        collectOption,
        [],
      )
      .option(
        "--always-on",
        "Keep the sandbox running until explicitly stopped or destroyed",
      )
      .option(
        "--non-persistent",
        "Discard filesystem state on timeout instead of pausing for resume",
      )
      .option(
        "--auto-start",
        "Seed and start the template app after the sandbox reaches running",
      ),
  )
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Note:
  White-label preview domains require external attribution at creation.
  Pass --external-workspace / --external-user / --external-project when the
  sandbox will be exposed on a white-label preview domain.
`,
    )
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
          externalWorkspace?: string;
          externalUser?: string;
          externalProject?: string;
          agentProfile?: string;
          skipAgentProfile?: boolean;
          networkPolicy?: string;
          allowedDomain?: string[];
          allowedCidr?: string[];
          deniedCidr?: string[];
          alwaysOn?: boolean;
          nonPersistent?: boolean;
          autoStart?: boolean;
        },
      ) =>
        runAction(async () => {
          const t0 = Date.now();
          const json = !!isJsonMode(opts) || process.env["MIOSA_JSON"] === "1";

          if (opts.data) {
            if (json) {
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
          const timeoutSec =
            opts.timeout ?? DEFAULT_INTERACTIVE_SANDBOX_TIMEOUT_SEC;
          body["timeout_sec"] = timeoutSec;
          if (opts.source) body["source"] = opts.source;
          if (opts.revision) body["revision"] = opts.revision;
          if (opts.depth != null) body["depth"] = opts.depth;
          if (opts.snapshot) body["snapshot_id"] = opts.snapshot;
          if (opts.agentProfile) {
            body["agent_runtime_profile_id"] = opts.agentProfile;
          }
          if (opts.skipAgentProfile) {
            body["skip_agent_runtime_profile"] = true;
          }
          const workspace =
            opts.workspace ??
            (program.opts() as { workspace?: string }).workspace ??
            process.env["MIOSA_WORKSPACE"];
          if (workspace) body["workspace_id"] = workspace;
          if (opts.externalWorkspace) {
            body["external_workspace_id"] = opts.externalWorkspace;
          }
          if (opts.externalUser) {
            body["external_user_id"] = opts.externalUser;
          }
          if (opts.externalProject) {
            body["external_project_id"] = opts.externalProject;
          }
          const networkPolicy = buildNetworkPolicy(opts);
          if (networkPolicy) {
            body["metadata"] = {
              ...((body["metadata"] as Record<string, unknown> | undefined) ??
                {}),
              network_policy: networkPolicy,
            };
          }
          if (opts.alwaysOn) body["always_on"] = true;
          body["persistent"] = opts.nonPersistent ? false : true;
          if (opts.autoStart) body["auto_start"] = true;

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
                Math.max(
                  Math.min(
                    opts.timeout ?? DEFAULT_CREATE_WAIT_TIMEOUT_SEC,
                    DEFAULT_CREATE_WAIT_TIMEOUT_SEC,
                  ),
                  30,
                ),
              );
              const latest = unwrap(
                await client().apiGet<unknown>(
                  apiPath(`/sandboxes/${enc(id)}`),
                ),
              );
              Object.assign(sb, latest, {
                preview,
                preview_url: preview.url,
                ready: preview.ready,
              });
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
              Math.max(
                Math.min(timeoutSec, DEFAULT_CREATE_WAIT_TIMEOUT_SEC),
                30,
              ),
            );
            Object.assign(sb, latest, { ready: true });
          }

          if (json) {
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
    .description(
      "Stop a persistent Sandbox session and preserve its filesystem",
    )
    .option(
      "--no-snapshot",
      "Deprecated compatibility flag; stop still preserves state server-side",
    )
    .option("--json", "Output as JSON")
    .action((id: string, opts: { snapshot?: boolean } & JsonOptions) =>
      runAction(async () => {
        const stopped = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/stop`),
            {},
          ),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(stopped, null, 2));
          return;
        }

        const row = (stopped ?? {}) as Record<string, unknown>;
        console.log(chalk.green("Sandbox stopped"));
        console.log(
          kvPanel([
            { label: "ID", value: str(row["id"] ?? id) },
            {
              label: "State",
              value: statusColor(str(row["state"] ?? "paused")),
            },
            { label: "Resume", value: `miosa sandbox resume ${id}` },
            { label: "Destroy", value: `miosa sandbox destroy ${id}` },
          ]),
        );
      }),
    );

  // resume — direct shortcut (mirrors `box resume`)
  sandbox
    .command("resume <sandbox-id>")
    .description("Resume a paused Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => resumeSandboxAndPrint(id, opts)),
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
        if (isJsonMode(opts)) {
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

  registerSandboxConnectorCommands(sandbox);

  // run-agent - invoke an in-Sandbox AI runner CLI.
  // Implemented through Runs so callers get a stable run response while
  // execution still happens inside the remote filesystem.
  sandbox
    .command("run-agent <sandbox-id> <instruction...>")
    .description(
      "Run an in-Sandbox AI agent runtime with the given instruction",
    )
    .option(
      "--runner <name>",
      "Runner: claude (default), claude-code, codex, pi, hermes, osa, custom",
    )
    .option(
      "--runtime-command <command>",
      "Executable command for --runner custom, e.g. 'hermes-agent run'",
    )
    .option("--model <name>", "Provider-specific model name")
    .option(
      "--connector <uid>",
      "MIOSA Connect connector UID to preflight before running the agent",
    )
    .option(
      "--preflight",
      "Verify the Sandbox has the requested provider connector before exec",
    )
    .option("--cwd <path>", "Working directory inside the Sandbox")
    .option(
      "--env <KEY=VALUE>",
      "Environment variable for the run. Repeatable.",
      collectOption,
      [],
    )
    .option("--agent-profile <id>", "Agent runtime profile ID")
    .option(
      "--skip-agent-profile",
      "Do not apply the default agent runtime profile",
    )
    .option(
      "--external-workspace <id>",
      "White-label workspace/customer ID for billing attribution",
    )
    .option(
      "--external-user <id>",
      "White-label user ID for billing attribution",
    )
    .option(
      "--external-project <id>",
      "White-label project ID for billing attribution",
    )
    .option("--timeout <sec>", "Exec timeout in seconds", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: {
          runner?: string;
          runtimeCommand?: string;
          model?: string;
          connector?: string;
          preflight?: boolean;
          cwd?: string;
          env?: string[];
          agentProfile?: string;
          skipAgentProfile?: boolean;
          externalWorkspace?: string;
          externalUser?: string;
          externalProject?: string;
          timeout?: number;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          const runner = opts.runner ?? "claude";
          if (!isSupportedRunAgentRunner(runner)) {
            const allowedRunners = supportedRunAgentRunners();
            throw new Error(
              `Unsupported runner "${runner}". Use: ${allowedRunners.join(", ")}`,
            );
          }
          if (opts.runtimeCommand && runner !== "custom") {
            throw new Error(
              "--runtime-command can only be used with --runner custom",
            );
          }
          if (opts.connector || opts.preflight) {
            await preflightSandboxConnector(id, {
              provider: runner,
              connector: opts.connector,
              model: opts.model,
              cwd: opts.cwd,
            });
          }
          const instruction = words.join(" ");
          const body: Record<string, unknown> = {
            target_kind: "sandbox",
            target_id: id,
            runner,
            instruction,
          };
          if (opts.runtimeCommand) body["command"] = opts.runtimeCommand;
          if (opts.model) body["model"] = opts.model;
          if (opts.cwd) body["cwd"] = opts.cwd;
          if (opts.env && opts.env.length > 0) {
            body["env"] = parseEnvPairs(opts.env);
          }
          if (opts.agentProfile) {
            body["agent_runtime_profile_id"] = opts.agentProfile;
          }
          if (opts.skipAgentProfile) {
            body["skip_agent_runtime_profile"] = true;
          }
          if (opts.externalWorkspace) {
            body["external_workspace_id"] = opts.externalWorkspace;
          }
          if (opts.externalUser) {
            body["external_user_id"] = opts.externalUser;
          }
          if (opts.externalProject) {
            body["external_project_id"] = opts.externalProject;
          }
          if (opts.timeout != null) body["timeout"] = opts.timeout;

          const run = unwrap(
            await client().apiPost<unknown>(apiPath("/runs"), body),
          ) as Record<string, unknown>;

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(run, null, 2));
            return;
          }

          console.log();
          console.log(
            kvPanel([
              { label: "Run", value: chalk.bold(str(run["id"])) },
              { label: "Target", value: `${str(run["target_kind"])} ${id}` },
              { label: "Runner", value: str(run["runner"]) },
              { label: "Status", value: statusColor(str(run["status"])) },
              { label: "Exit", value: str(run["exit_code"]) },
            ]),
          );

          const output = str(run["output"]).trim();
          const stderr = str(run["stderr"]).trim();
          if (output) {
            console.log();
            console.log(output);
          }
          if (stderr) {
            console.error();
            console.error(chalk.red(stderr));
          }
          console.log();
        }),
    );

  // exec — positional command arg; --data body overrides when supplied
  addDataOption(
    sandbox
      .command("exec <sandbox-id> [command...]")
      .description(
        'Run a command inside a Sandbox (positional args joined as shell command). Use `--` before the command to pass flags, e.g. `sandbox exec <id> -- bash -c "cd x && y"`.',
      )
      .allowUnknownOption()
      .allowExcessArguments()
      .option("--cwd <path>", "Working directory inside the Sandbox")
      .option("--workdir <path>", "Alias for --cwd")
      .option(
        "--cmd <command>",
        "Explicit command string to run; avoids CLI parsing command flags",
      )
      .option("--command <command>", "Alias for --cmd")
      .option(
        "--shell-cmd <shell>",
        "Run --cmd through this shell, e.g. 'bash -lc'",
      )
      .option(
        "--env <pair>",
        "Environment variable KEY=VALUE. Repeatable.",
        collectOption,
        [],
      )
      .option(
        "--background",
        "Start the command in the background and return immediately",
      )
      .option(
        "--detached",
        "Create a durable backend command and return command_id immediately",
      )
      .option(
        "--follow",
        "Stream command output until it exits (alias --stream)",
      )
      .option("--stream", "Alias for --follow")
      .option("--user <user>", "Run command as user")
      .option("--sudo", "Run command through sudo")
      .option("--tty", "Request TTY metadata for command resource")
      .option(
        "--interactive",
        "Request interactive metadata for command resource",
      )
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
          cmd?: string;
          command?: string;
          shellCmd?: string;
          env?: string[];
          background?: boolean;
          detached?: boolean;
          follow?: boolean;
          stream?: boolean;
          user?: string;
          sudo?: boolean;
          tty?: boolean;
          interactive?: boolean;
          timeout?: number;
        },
      ) =>
        runAction(async () => {
          opts.follow = opts.follow || opts.stream;
          if (opts.data) {
            await postSandboxExecAndPrint(id, opts, {});
            return;
          }
          const cmd = resolveSandboxCommand(words, opts);
          const effectiveCommand = opts.background
            ? backgroundCommand(cmd)
            : cmd;
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
            if (isJsonMode(opts)) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(String(result["id"] ?? result["command_id"] ?? ""));
            return;
          }
          if (opts.follow) {
            await runFollowExec(id, cmd, cwd, env, opts.timeout, opts);
            return;
          }
          if (Object.keys(env).length > 0) body["env"] = env;
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postSandboxExecAndPrint(id, opts, body);
        }),
    );

  // run — alias for exec with identical semantics
  addDataOption(
    sandbox
      .command("run <sandbox-id> [command...]")
      .description(
        "Run a command inside a Sandbox (alias for exec). Use `--` before the command to pass flags.",
      )
      .allowUnknownOption()
      .allowExcessArguments()
      .option("--cwd <path>", "Working directory inside the Sandbox")
      .option("--workdir <path>", "Alias for --cwd")
      .option(
        "--cmd <command>",
        "Explicit command string to run; avoids CLI parsing command flags",
      )
      .option("--command <command>", "Alias for --cmd")
      .option(
        "--shell-cmd <shell>",
        "Run --cmd through this shell, e.g. 'bash -lc'",
      )
      .option(
        "--env <pair>",
        "Environment variable KEY=VALUE. Repeatable.",
        collectOption,
        [],
      )
      .option(
        "--background",
        "Start the command in the background and return immediately",
      )
      .option(
        "--detached",
        "Create a durable backend command and return command_id immediately",
      )
      .option(
        "--follow",
        "Stream command output until it exits (alias --stream)",
      )
      .option("--stream", "Alias for --follow")
      .option("--user <user>", "Run command as user")
      .option("--sudo", "Run command through sudo")
      .option("--tty", "Request TTY metadata for command resource")
      .option(
        "--interactive",
        "Request interactive metadata for command resource",
      )
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
          cmd?: string;
          command?: string;
          shellCmd?: string;
          env?: string[];
          background?: boolean;
          detached?: boolean;
          follow?: boolean;
          stream?: boolean;
          user?: string;
          sudo?: boolean;
          tty?: boolean;
          interactive?: boolean;
          timeout?: number;
        },
      ) =>
        runAction(async () => {
          opts.follow = opts.follow || opts.stream;
          if (opts.data) {
            await postSandboxExecAndPrint(id, opts, {});
            return;
          }
          const cmd = resolveSandboxCommand(words, opts);
          const effectiveCommand = opts.background
            ? backgroundCommand(cmd)
            : cmd;
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
            if (isJsonMode(opts)) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(String(result["id"] ?? result["command_id"] ?? ""));
            return;
          }
          if (opts.follow) {
            await runFollowExec(id, cmd, cwd, env, opts.timeout, opts);
            return;
          }
          if (Object.keys(env).length > 0) body["env"] = env;
          if (opts.timeout != null) body["timeout"] = opts.timeout;
          await postSandboxExecAndPrint(id, opts, body);
        }),
    );

  sandbox
    .command("ports <sandbox-id>")
    .description("List listening TCP ports inside a Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = await client().apiGet<unknown>(
          apiPath(`/sandboxes/${enc(id)}/ports`),
        );
        const ports = sandboxPortsFromResponse(result);
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (ports.length === 0) {
          console.log(chalk.dim("(no listening ports)"));
          return;
        }
        renderTable(ports, [
          {
            header: "PROTO",
            key: (p) => p.protocol ?? "tcp",
            width: 8,
          },
          {
            header: "PORT",
            key: "port" as keyof PortBinding,
            width: 8,
          },
          {
            header: "ADDRESS",
            key: "address" as keyof PortBinding,
            width: 24,
          },
          {
            header: "STATE",
            key: (p) => p.state ?? "listen",
            width: 10,
          },
          {
            header: "PROCESS",
            key: (p) =>
              p.process?.name
                ? `${p.process.name}${p.process.pid ? `:${p.process.pid}` : ""}`
                : chalk.dim("-"),
            width: 28,
          },
        ]);
      }),
    );

  sandbox
    .command("metrics <sandbox-id>")
    .description(
      "Show Sandbox resource, uptime, timeout, and readiness metrics",
    )
    .option("--window <window>", "Metrics window: 1h, 24h, or 7d", "1h")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions & { window: string }) =>
      runAction(async () => {
        const result = await client().apiGet<unknown>(
          apiPath(`/sandboxes/${enc(id)}/metrics?window=${enc(opts.window)}`),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        renderResourceMetrics("Sandbox metrics", result);
      }),
    );

  sandbox
    .command("deploy [local-dir]")
    .description(
      "Upload an app directory, start it in a sandbox, expose a preview URL, and wait for readiness",
    )
    .option("--sandbox <id>", "Existing sandbox ID. Creates one when omitted")
    .option(
      "--template <template>",
      "Template for new sandbox",
      "miosa-sandbox",
    )
    .option("--name <name>", "Name for a new sandbox")
    .option("--port <port>", "Preview port", parseIntegerOption)
    .option("--publish-port <port>", "Alias for --port", parseIntegerOption)
    .option("--start <command>", "Start command to run inside /workspace")
    .option(
      "--install-command <command>",
      "Install command to run before start",
    )
    .option("--no-install", "Skip automatic dependency install")
    .option(
      "--source <source>",
      "Source: git:https://... or tarball:https://... for repo-backed preview deploy",
    )
    .option("--revision <revision>", "Git revision/branch for --source git:...")
    .option(
      "--depth <n>",
      "Git clone depth for --source git:...",
      parseIntegerOption,
    )
    .option(
      "--wait",
      "Wait until the public preview returns a good HTTP status",
    )
    .option(
      "--timeout <duration>",
      "Wait timeout, e.g. 180s or 3m",
      parseDurationSec,
      180,
    )
    .option("--probe-path <path>", "HTTP path to probe")
    .option("--json", "Output as JSON")
    .action(
      async (
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
          source?: string;
          revision?: string;
          depth?: number;
          wait?: boolean;
          timeout: number;
          probePath?: string;
          json?: boolean;
        },
      ) => {
        try {
          const result = await deploySandbox(localDir, opts);
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Sandbox")}  ${result.sandbox_id}`);
          console.log(`  ${chalk.bold("Port")}     ${result.port}`);
          console.log(
            `  ${chalk.bold("Preview")}  ${chalk.cyan(result.preview_url)}`,
          );
          console.log(
            `  ${chalk.bold("Ready")}    ${
              result.preview_ready
                ? chalk.green("yes")
                : chalk.yellow("not verified")
            }`,
          );
          console.log();
        } catch (err) {
          handleSandboxDeployError(err, opts);
        }
      },
    );

  sandbox
    .command("preview <sandbox-id>")
    .description(
      "Expose a sandbox port and optionally wait for the public preview to answer",
    )
    .requiredOption(
      "--port <port>",
      "Port inside the sandbox to expose",
      parseIntegerOption,
    )
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
          if (isJsonMode(opts)) {
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
    .description(
      "Wait for sandbox VM readiness; pass --port to also verify app preview readiness",
    )
    .option(
      "--port <port>",
      "Port inside the sandbox to check",
      parseIntegerOption,
    )
    .option("--url", "Print only the ready public preview URL")
    .option("--timeout <sec>", "Wait timeout in seconds", parseDurationSec, 120)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: {
          port?: number;
          url?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result =
            opts.port == null
              ? await waitSandboxVmReady(id, opts.timeout)
              : await waitSandboxReady(
                  id,
                  opts.port,
                  opts.probePath,
                  opts.timeout,
                );
          if (opts.url && result.url) {
            console.log(result.url);
            return;
          }
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green("Ready"));
          if (result.url) console.log(chalk.cyan(result.url));
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
        opts: {
          wait?: boolean;
          timeout: number;
          probePath: string;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const port = Number(portText);
          if (!Number.isInteger(port))
            throw new UserError(`Invalid port: ${portText}`);
          const result = await previewSandbox(id, port, {
            wait: !!opts.wait,
            timeout: opts.timeout,
            probePath: opts.probePath,
          });
          const data = { port, ...result };
          if (isJsonMode(opts)) {
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
    .option(
      "--app <id>",
      "Existing app/deployment ID to publish a new release to",
    )
    .option("--name <name>", "Name for a new durable app")
    .option("--slug <slug>", "Production slug for a new durable app")
    .option("--environment <name>", "Target environment label", "production")
    .option("--build-command <cmd>", "Build command to run before publishing")
    .option("--run-command <cmd>", "Run command for dynamic/server deployments")
    .option(
      "--docker-deploy",
      "Publish onto the workspace App Engine runtime instead of standard app hosting",
    )
    .option("--domain <domain>", "Custom domain to attach")
    .option(
      "--deployment-type <type>",
      "Deployment runtime type: miosa_deploy, docker_deploy, dynamic, static",
    )
    .option(
      "--database <mode>",
      "none, create:postgres, postgres, or existing:<db-id>",
    )
    .option(
      "--port <port>",
      "Runtime port for dynamic deployments",
      parseIntegerOption,
    )
    .option("--wait", "Wait for the production URL to answer")
    .option(
      "--no-wait",
      "Return immediately without waiting (this is the default)",
    )
    .option("--timeout <duration>", "Wait timeout", parseDurationSec, 600)
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
          dockerDeploy?: boolean;
          domain?: string;
          deploymentType?: string;
          database?: string;
          port?: number;
          wait?: boolean;
          timeout: number;
          json?: boolean;
        },
      ) =>
        runAction(async () => {
          const result = await publishSandbox(id, opts);
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Type")}     deployment`);
          console.log(
            `  ${chalk.bold("App")}      ${result.deployment_id ?? result.app_id ?? ""}`,
          );
          if (result.release_id)
            console.log(`  ${chalk.bold("Release")}  ${result.release_id}`);
          if (result.deployment_product)
            console.log(
              `  ${chalk.bold("Product")}  ${String(result.deployment_product)}`,
            );
          if (result.docker_deploy_host_id)
            console.log(
              `  ${chalk.bold("Docker")}   ${String(result.docker_deploy_host_id)}`,
            );
          if (result.url)
            console.log(
              `  ${chalk.bold("URL")}      ${chalk.cyan(String(result.url))}`,
            );
          console.log(
            `  ${chalk.bold("Ready")}    ${result.ready ? chalk.green("yes") : chalk.yellow("pending")}`,
          );
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
    .option(
      "--follow",
      "Follow logs (currently returns tailed logs when backend SSE is unavailable)",
    )
    .option("--tail <n>", "Number of lines", parseIntegerOption, 200)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        commandId: string,
        opts: { follow?: boolean; tail: number; json?: boolean },
      ) =>
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
    .requiredOption(
      "--timeout <duration>",
      "New timeout, e.g. 2h",
      parseDurationSec,
    )
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
    .description(
      "Show sandbox runtime, rough resource usage, and estimated cost",
    )
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
    .option(
      "--network-policy <policy>",
      "Network policy: allow-all or deny-all",
    )
    .option(
      "--allowed-domain <domain>",
      "Allowed egress domain. Repeatable.",
      collectOption,
      [],
    )
    .option(
      "--allowed-cidr <cidr>",
      "Allowed egress CIDR. Repeatable.",
      collectOption,
      [],
    )
    .option(
      "--denied-cidr <cidr>",
      "Denied egress CIDR. Repeatable.",
      collectOption,
      [],
    )
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
          if (!policy)
            throw new UserError("No network policy options provided.");
          const result = unwrap(
            await client().apiPatch<unknown>(apiPath(`/sandboxes/${enc(id)}`), {
              metadata: { network_policy: policy },
            }),
          );
          if (isJsonMode(opts)) {
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
    .alias("up")
    .requiredOption("--cmd <command>", "Command to start")
    .option(
      "--cwd <path>",
      "Working directory inside the sandbox",
      "/workspace",
    )
    .option("--port <port>", "Port served by this service", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        name: string,
        opts: { cmd: string; cwd: string; port?: number; json?: boolean },
      ) =>
        runAction(async () => {
          const result = await startSandboxService(id, name, opts);
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green(`Started ${name}`));
          if (result.preview_url)
            console.log(chalk.cyan(String(result.preview_url)));
        }),
    );

  service
    .command("restart <sandbox-id> <name>")
    .option(
      "--cmd <command>",
      "Ignored when backend service metadata already exists",
    )
    .option(
      "--cwd <path>",
      "Working directory inside the sandbox",
      "/workspace",
    )
    .option("--port <port>", "Port served by this service", parseIntegerOption)
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        name: string,
        opts: { cmd: string; cwd: string; port?: number; json?: boolean },
      ) =>
        runAction(async () => {
          const result = unwrap(
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/services/${enc(name)}/restart`),
              {},
            ),
          ) as Record<string, unknown>;
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.green(`Restarted ${name}`));
          if (result.preview_url)
            console.log(chalk.cyan(String(result.preview_url)));
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
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          status === "running" ? chalk.green(status) : chalk.yellow(status),
        );
      }),
    );

  service
    .command("logs <sandbox-id> <name>")
    .option("--lines <n>", "Number of log lines", parseIntegerOption, 100)
    .option("--json", "Output as JSON")
    .action(
      (id: string, name: string, opts: { lines: number; json?: boolean }) =>
        runAction(async () => {
          const result = unwrap(
            await client().apiGet<unknown>(
              apiPath(
                `/sandboxes/${enc(id)}/services/${enc(name)}/logs?tail=${Number(opts.lines) || 100}`,
              ),
            ),
          ) as Record<string, unknown>;
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const lines = Array.isArray(result["lines"]) ? result["lines"] : [];
          process.stdout.write(
            lines.join("\n") + (lines.length > 0 ? "\n" : ""),
          );
        }),
    );

  const env = sandbox
    .command("env")
    .description("Manage encrypted environment variables for a sandbox");

  env
    .command("list <sandbox-id>")
    .description("List sandbox env var names and masked previews")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiGet<unknown>(apiPath(`/sandboxes/${enc(id)}/env`)),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const rows = Array.isArray(result)
          ? (result as Record<string, unknown>[])
          : [];
        if (rows.length === 0) {
          console.log(chalk.dim("No sandbox env vars."));
          return;
        }
        renderTable(rows, [
          {
            header: "NAME",
            key: "name" as keyof Record<string, unknown>,
            width: 32,
          },
          {
            header: "VALUE",
            key: "preview" as keyof Record<string, unknown>,
            width: 24,
          },
          {
            header: "UPDATED",
            key: "updated_at" as keyof Record<string, unknown>,
            width: 28,
          },
        ]);
      }),
    );

  env
    .command("set <sandbox-id> <pairs...>")
    .description("Set encrypted sandbox env vars as KEY=VALUE")
    .option("--json", "Output as JSON")
    .action((id: string, pairs: string[], opts: JsonOptions) =>
      runAction(async () => {
        const vars = Object.entries(parseEnvPairs(pairs)).map(
          ([key, value]) => ({
            key,
            value,
          }),
        );
        const result = unwrap(
          await client().apiPut<unknown>(apiPath(`/sandboxes/${enc(id)}/env`), {
            vars,
          }),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Set ${vars.length} sandbox env var(s).`));
      }),
    );

  env
    .command("delete <sandbox-id> <key>")
    .alias("unset")
    .description("Delete an encrypted sandbox env var")
    .option("--json", "Output as JSON")
    .action((id: string, key: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiDelete<unknown>(
            apiPath(`/sandboxes/${enc(id)}/env/${enc(key)}`),
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Deleted ${key}.`));
      }),
    );

  env
    .command("sync <sandbox-id>")
    .description("Sync encrypted sandbox env vars into the running VM")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/env/sync`),
            {},
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const status =
          result && typeof result === "object" && "status" in result
            ? String((result as Record<string, unknown>)["status"])
            : "ok";
        console.log(chalk.green(`Sandbox env sync ${status}.`));
      }),
    );

  const sandboxDb = sandbox
    .command("db")
    .description("Attach managed databases to sandboxes");

  sandboxDb
    .command("attach <sandbox-id> <database-id>")
    .description("Attach a managed database and persist DATABASE_URL env vars")
    .option("--json", "Output as JSON")
    .action((id: string, databaseId: string, opts: JsonOptions) =>
      runAction(async () => {
        const result = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/database`),
            { database_id: databaseId },
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          chalk.green(`Attached database ${databaseId} to sandbox ${id}.`),
        );
      }),
    );

  sandbox
    .command("doctor [sandbox-id]")
    .description(
      "Diagnose sandbox app readiness across sandbox state, internal HTTP, public route, and TLS/edge reachability",
    )
    .option(
      "--port <port>",
      "Port inside the sandbox to check",
      parseIntegerOption,
    )
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--full", "Inspect the complete canonical developer contract")
    .option("--dir <path>", "Project directory for --full", ".")
    .option("--json", "Output as JSON")
    .action(
      (id: string | undefined, opts: { port?: number; probePath: string; full?: boolean; dir: string; json?: boolean }) =>
        runAction(async () => {
          if (opts.full) {
            const report = await runFullSandboxDoctor(opts.dir, id);
            if (!report.ok) process.exitCode = 1;
            if (isJsonMode(opts)) {
              console.log(JSON.stringify(report, null, 2));
              return;
            }
            console.log();
            console.log(chalk.bold("Sandbox Doctor Full"));
            console.log();
            for (const check of report.checks) {
              console.log(`  ${check.ok ? chalk.green("ok") : chalk.red("fail")} ${check.id}: ${check.message}`);
            }
            console.log();
            return;
          }
          if (!id || opts.port == null) {
            throw new UserError(
              "Sandbox ID and --port are required unless --full is used.",
              "Use miosa sandbox doctor <sandbox-id> --port <port>, or miosa sandbox doctor --full.",
            );
          }
          const report = await doctorSandbox(id, opts.port, opts.probePath);
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          renderDoctorReport(report);
        }),
    );

  sandbox
    .command("recover <name-or-id>")
    .description(
      "Inspect a failed or partial sandbox deploy and print recovery commands",
    )
    .option("--port <port>", "App port to diagnose", parseIntegerOption)
    .option("--probe-path <path>", "HTTP path to probe", "/")
    .option("--json", "Output as JSON")
    .action(
      (
        idOrName: string,
        opts: { port?: number; probePath: string; json?: boolean },
      ) =>
        runAction(async () => {
          const report = await recoverSandboxDeploy(idOrName, opts);
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          renderRecoverReport(report);
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
          const result = await writeBytesToSandbox(
            client(),
            id,
            remotePath,
            contentBytes,
          );
          if (!isJsonMode(opts)) {
            console.log(chalk.green(`Written to ${remotePath}`));
          } else {
            printValue(
              typeof result === "string" ? { content: result } : result,
              opts,
            );
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
        const result = await client().apiGet<unknown>(
          apiPath(`/sandboxes/${enc(id)}/files/read?path=${enc(remotePath)}`),
        );
        if (isJsonMode(opts)) {
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
          const c = client();
          const result = await writeBytesToSandbox(
            c,
            id,
            remotePath,
            fs.readFileSync(localPath),
          );
          if (isJsonMode(opts)) {
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
    .option(
      "--delete",
      "Delete the remote directory contents before extracting",
    )
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
          if (isJsonMode(opts)) {
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
    .option(
      "--delete",
      "Delete the remote directory contents before extracting",
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        localDir: string,
        remoteDir: string,
        opts: { sandbox: string; delete?: boolean; json?: boolean },
      ) => {
        try {
          const result = await uploadDirToSandbox(
            opts.sandbox,
            localDir,
            remoteDir,
            {
              delete: !!opts.delete,
            },
          );
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(
            chalk.green(`Synced ${result.files_label} → ${remoteDir}`),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  sandbox
    .command("cp <source> <target>")
    .alias("copy")
    .description(
      "Copy a local file or directory into a sandbox, e.g. ./app/. sbx_123:/workspace",
    )
    .option(
      "--delete",
      "Delete the remote directory contents before extracting directories",
    )
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
            if (isJsonMode(opts)) {
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
            if (isJsonMode(opts)) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              chalk.green(`Copied ${result.files_label} → ${target}`),
            );
            return;
          }
          const c = client();
          await uploadFileToSandbox(
            c,
            parsed.sandboxId,
            local,
            parsed.remotePath,
          );
          if (isJsonMode(opts)) {
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
          console.log(
            chalk.green(`Copied ${path.basename(local)} → ${target}`),
          );
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
          const bytes = await c.apiGetBinary(
            apiPath(`/sandboxes/${enc(id)}/files/${encoded}`),
          );

          if (opts.output) {
            fs.writeFileSync(opts.output, bytes);
            if (isJsonMode(opts)) {
              console.log(
                JSON.stringify(
                  {
                    sandbox_id: id,
                    remote_path: remotePath,
                    output: opts.output,
                    bytes: bytes.length,
                  },
                  null,
                  2,
                ),
              );
              return;
            }
            console.log(
              chalk.green(`Downloaded ${remotePath} → ${opts.output}`),
            );
          } else {
            if (isJsonMode(opts)) {
              console.log(
                JSON.stringify(
                  {
                    sandbox_id: id,
                    remote_path: remotePath,
                    bytes: bytes.length,
                    content_base64: bytes.toString("base64"),
                  },
                  null,
                  2,
                ),
              );
              return;
            }
            process.stdout.write(bytes);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  sandbox
    .command("export <sandbox-id> <remote-paths...>")
    .description(
      "Create a portable export for sandbox-generated files; optionally download it",
    )
    .option("--label <label>", "Human-readable export label")
    .option("--filename <name>", "Filename to use when downloading")
    .option("--output <file>", "Download the file/archive to this local path")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        remotePaths: string[],
        opts: {
          label?: string;
          filename?: string;
          output?: string;
          json?: boolean;
        },
      ) => {
        try {
          if (remotePaths.length === 0) {
            throw new UserError("At least one remote path is required.");
          }

          const body: Record<string, unknown> =
            remotePaths.length === 1
              ? { path: remotePaths[0] }
              : { paths: remotePaths };
          if (opts.label) body["label"] = opts.label;
          if (opts.filename) body["filename"] = opts.filename;

          const exportData = unwrap(
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/exports`),
              body,
            ),
          ) as Record<string, unknown>;

          if (opts.output) {
            const query = new URLSearchParams();
            if (remotePaths.length === 1) {
              query.set("path", remotePaths[0] ?? "");
            } else {
              for (const remotePath of remotePaths) {
                query.append("paths[]", remotePath);
              }
            }
            if (opts.filename) query.set("filename", opts.filename);
            const bytes = await client().apiGetBinary(
              apiPath(`/sandboxes/${enc(id)}/exports/download?${query.toString()}`),
            );
            fs.writeFileSync(opts.output, bytes);
          }

          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                opts.output
                  ? { ...exportData, downloaded_to: opts.output }
                  : exportData,
                null,
                2,
              ),
            );
            return;
          }

          console.log();
          console.log(
            kvPanel([
              { label: "Export", value: chalk.bold(str(exportData["id"])) },
              { label: "Sandbox", value: id },
              { label: "Status", value: statusColor(str(exportData["status"])) },
              {
                label: "Archive",
                value: str(exportData["archive_download_url"]),
              },
              ...(opts.output
                ? [{ label: "Downloaded", value: opts.output }]
                : []),
            ]),
          );
          const files = Array.isArray(exportData["files"])
            ? (exportData["files"] as Record<string, unknown>[])
            : [];
          if (files.length > 0) {
            console.log();
            renderTable(files, [
              { header: "PATH", key: "path" as keyof Record<string, unknown> },
              {
                header: "DOWNLOAD URL",
                key: "download_url" as keyof Record<string, unknown>,
              },
            ]);
          }
          console.log();
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
    .option(
      "-p, --port <n>",
      "Local port for the tunnel listener",
      parseIntegerOption,
    )
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
    .option(
      "-p, --port <n>",
      "Local port for the tunnel listener",
      parseIntegerOption,
    )
    .option("-l, --user <name>", "SSH user (default: root)")
    .option("--json", "Output connection info as JSON")
    .action(
      async (
        id: string,
        opts: { port?: number; user?: string; json?: boolean },
      ) => {
        try {
          await runSandboxSsh(id, { ...opts, spawn: !isJsonMode(opts) });
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
    .option(
      "--wait",
      "Probe the local forwarded URL before returning readiness",
    )
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
            json: !!isJsonMode(opts),
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
          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify({ snapshot, stopped: !!opts.stop }, null, 2),
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
      runAction(() => getAndPrint(`/sandboxes/${enc(id)}/snapshots`, opts)),
    );

  snapshots
    .command("get <sandbox-id> <snapshot-id>")
    .description("Get a sandbox snapshot")
    .option("--json", "Output as JSON")
    .action((id: string, snapshotId: string, opts: JsonOptions) =>
      runAction(() =>
        getAndPrint(`/sandboxes/${enc(id)}/snapshots/${enc(snapshotId)}`, opts),
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

function registerSandboxConnectorCommands(sandbox: Command): void {
  const connectors = sandbox
    .command("connectors")
    .alias("providers")
    .description("Manage brokered provider connector bindings for a Sandbox");

  connectors
    .command("list <sandbox-id>")
    .description("List provider connectors bound to a Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/sandboxes/${enc(id)}/connectors`),
          ),
        );
        printValue(raw, opts);
      }),
    );

  connectors
    .command("attach <sandbox-id> <connector>")
    .description("Attach a connector to a Sandbox as brokered env")
    .requiredOption(
      "--env <name>",
      "Environment variable name, e.g. ANTHROPIC_API_KEY",
    )
    .option("--mode <mode>", "brokered-env or plain-env", "brokered-env")
    .option("--installation-id <id>", "Provider installation ID")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        connector: string,
        opts: JsonOptions & {
          env: string;
          mode?: string;
          installationId?: string;
        },
      ) =>
        runAction(async () => {
          const body = {
            connector,
            env_name: opts.env,
            mode: normalizeConnectorMode(opts.mode ?? "brokered-env"),
            installation_id: opts.installationId,
          };
          const raw = unwrap(
            await client().apiPost<unknown>(
              apiPath(`/sandboxes/${enc(id)}/connectors`),
              body,
            ),
          );
          printValue(raw, opts);
        }),
    );

  connectors
    .command("detach <sandbox-id> <binding-id-or-connector>")
    .description("Detach a connector binding from a Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, binding: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(
          `/sandboxes/${enc(id)}/connectors/${enc(binding)}`,
          opts,
        ),
      ),
    );

  connectors
    .command("sync <sandbox-id>")
    .description("Sync connector placeholder env vars into a running Sandbox")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/sandboxes/${enc(id)}/connectors/sync`),
            {},
          ),
        );
        printValue(raw, opts);
      }),
    );
}

function normalizeConnectorMode(value: string): string {
  return value.replaceAll("_", "-");
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
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  if (!fs.existsSync(SANDBOX_KEY_PATH)) {
    console.log(
      chalk.dim("Generating SSH keypair for MIOSA sandbox access..."),
    );
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
  }

  // Register the public key with every target sandbox. The local key can
  // already exist from a previous sandbox, but a fresh sandbox still needs it
  // installed in authorized_keys before SSH auth can succeed.
  const pubKey = fs.readFileSync(`${SANDBOX_KEY_PATH}.pub`, "utf8").trim();
  const endpoint = config.endpoint.replace(/\/$/, "");
  const response = await fetch(
    `${endpoint}${apiPath(`/sandboxes/${encodeURIComponent(id)}/ssh-keys`)}`,
    {
      method: "POST",
      headers: {
        ...sandboxTransportHeaders(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ public_key: pubKey }),
    },
  );
  if (!response.ok) {
    const rawBody = await response.text();
    let body: ApiErrorBody = {};
    try {
      body = JSON.parse(rawBody) as ApiErrorBody;
    } catch {
      body = { message: rawBody || `HTTP ${response.status}` };
    }
    throw mapHttpError(
      response.status,
      body,
      rawBody,
      response.headers.get("x-request-id"),
    );
  }

  console.log(chalk.green("SSH key registered."));
}

function sandboxTransportHeaders(
  config: ReturnType<typeof loadConfig>,
): Record<string, string> {
  if (!config.api_key) throw new Error("Not authenticated. Run: miosa login");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${String(config.api_key)}`,
  };
  if (config.tenant) headers["X-MIOSA-Tenant"] = config.tenant;
  if (config.workspace) headers["X-MIOSA-Workspace"] = config.workspace;
  return headers;
}

export function buildSandboxWebSocketRequest(
  config: ReturnType<typeof loadConfig>,
  id: string,
): {
  url: string;
  headers: Record<string, string>;
} {
  const base = config.endpoint.replace(/\/$/, "");
  const wsBase = base.replace(/^https?/, (protocol) =>
    protocol === "https" ? "wss" : "ws",
  );
  const url = new URL(
    `${wsBase}/api/v1/sandboxes/${encodeURIComponent(id)}/ssh-tunnel`,
  );
  const headers = sandboxTransportHeaders(config);

  if (config.tenant) {
    url.searchParams.set("tenant", config.tenant);
  }
  if (config.workspace) {
    url.searchParams.set("workspace", config.workspace);
  }

  return { url: url.toString(), headers };
}

function bridgeSandboxWs(
  socket: Socket,
  request: ReturnType<typeof buildSandboxWebSocketRequest>,
): void {
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) socket.destroy();
  }

  const ws = new WebSocket(request.url, {
    headers: request.headers,
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
  const wsRequest = buildSandboxWebSocketRequest(config, id);

  await ensureSandboxSshKey(id, config);

  // Pick a free local port
  const localPort = opts.port ?? (await pickFreePort());
  const user = opts.user ?? "root";

  if (isJsonMode(opts)) {
    console.log(
      JSON.stringify({
        sandbox_id: id,
        local_port: localPort,
        user,
        ws_url: wsRequest.url,
        key_path: SANDBOX_KEY_PATH,
      }),
    );
    return;
  }

  const server = createServer((socket) => {
    bridgeSandboxWs(socket, wsRequest);
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
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "text/plain" });
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

  if (isJsonMode(opts)) {
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
    if (isJsonMode(opts) || stats.active === 0) return;
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
  source?: string;
  revision?: string;
  depth?: number;
  wait?: boolean;
  timeout: number;
  probePath?: string;
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

class SandboxDeployPartialError extends Error {
  constructor(
    public readonly causeError: unknown,
    public readonly sandboxId: string,
    public readonly recoveryCommand: string,
  ) {
    super(
      causeError instanceof Error ? causeError.message : String(causeError),
    );
    this.name = "SandboxDeployPartialError";
  }
}

interface SandboxPublishOptions {
  path: string;
  app?: string;
  name?: string;
  slug?: string;
  environment: string;
  buildCommand?: string;
  runCommand?: string;
  dockerDeploy?: boolean;
  domain?: string;
  deploymentType?: string;
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
  deployment_product: string | null;
  docker_deploy_host_id: string | null;
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
): Promise<
  PreviewResult & {
    sandbox_id: string;
    port: number;
    internal_status: number | null;
  }
> {
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

async function waitSandboxVmReady(
  sandboxId: string,
  timeoutSec: number,
): Promise<
  Record<string, unknown> & {
    sandbox_id: string;
    ready: boolean;
    url: null;
  }
> {
  const sandbox = await waitForSandboxRunning(client(), sandboxId, timeoutSec);
  return {
    ...sandbox,
    sandbox_id: sandboxId,
    ready: true,
    url: null,
  };
}

async function startSandboxService(
  sandboxId: string,
  name: string,
  opts: { cmd: string; cwd: string; port?: number },
): Promise<Record<string, unknown>> {
  validateServiceName(name);
  const result = unwrap(
    await client().apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/services`),
      {
        name,
        command: opts.cmd,
        cwd: opts.cwd,
      },
    ),
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
    await client().apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/commands`),
      {
        command,
        cwd: opts.cwd,
        env: opts.env,
        user: opts.user,
        sudo: opts.sudo,
        tty: opts.tty,
        interactive: opts.interactive,
        timeout: opts.timeout,
      },
    ),
  ) as Record<string, unknown>;
  return {
    ...result,
    command_id: result["id"],
    status: result["status"] ?? "running",
  };
}

function warnOnTemplatePortMismatch(
  template: string | null,
  port: number,
  opts: JsonOptions,
): void {
  if (isJsonMode(opts)) return;
  if ((template === "nextjs" || template === "next-js") && port !== 3000) {
    console.error(
      chalk.yellow(
        "Next.js sandbox templates default to port 3000. Use --port 3000 unless you intentionally changed the app readiness port.",
      ),
    );
  }
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
  const sourceBacked = !!opts.source;
  if (
    !sourceBacked &&
    (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory())
  ) {
    throw new UserError(`Local directory not found: ${sourceDir}`);
  }

  const c = client();
  let appManifest = sourceBacked
    ? null
    : (loadAppManifest(sourceDir)?.manifest ?? null);
  const detection = sourceBacked ? null : detectFramework(sourceDir);
  const port =
    opts.port ??
    opts.publishPort ??
    manifestPort(appManifest) ??
    detection?.port ??
    5173;
  warnOnTemplatePortMismatch(
    opts.template ?? appManifest?.template ?? null,
    port,
    opts,
  );
  const probePath = opts.probePath ?? manifestProbePath(appManifest) ?? "/";
  let remoteWorkdir = normalizeRemoteWorkdir(
    appManifest?.workdir ?? "/workspace",
  );
  const start =
    opts.start ??
    manifestStartCommand(appManifest) ??
    defaultStartCommand(detection?.framework ?? appManifest?.framework, port);
  let sandboxId = opts.sandbox ?? null;

  try {
    if (!sandboxId) {
      deployStep(opts, "Creating sandbox");
      sandboxId = await createSandboxForDeploy(
        c,
        opts.template ?? appManifest?.template ?? "miosa-sandbox",
        opts.name,
        {
          source: opts.source,
          revision: opts.revision,
          depth: opts.depth,
        },
      );
    }

    deployStep(opts, "Waiting for sandbox");
    await waitForSandboxRunning(c, sandboxId, Math.min(opts.timeout, 120));

    if (sourceBacked) {
      deployStep(opts, "Waiting for source import");
      appManifest = await readRemoteAppManifest(c, sandboxId, opts.timeout);
      remoteWorkdir = normalizeRemoteWorkdir(
        appManifest?.workdir ?? "/workspace",
      );
    } else {
      deployStep(opts, "Uploading files");
      const archivePath = createDeployArchive(sourceDir);
      const remoteArchive = `/tmp/miosa-deploy-${Date.now()}.tgz`;
      try {
        await uploadFileToSandbox(c, sandboxId, archivePath, remoteArchive);
        deployStep(opts, "Extracting workspace");
        await execSandbox(
          c,
          sandboxId,
          `mkdir -p ${shellQuote(remoteWorkdir)} && tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteWorkdir)}`,
          "/",
        );
      } finally {
        fs.rmSync(archivePath, { force: true });
      }
    }
    const resolvedPort =
      opts.port ?? opts.publishPort ?? manifestPort(appManifest) ?? port;
    const resolvedProbePath =
      opts.probePath ?? manifestProbePath(appManifest) ?? probePath;
    const resolvedStart =
      opts.start ?? manifestStartCommand(appManifest) ?? start;
    const installCommand =
      opts.install === false
        ? null
        : (opts.installCommand ??
          (appManifest?.install === false ? null : appManifest?.install) ??
          (sourceBacked ? "npm install" : defaultInstallCommand(sourceDir)));

    if (installCommand) {
      deployStep(opts, `Installing dependencies: ${installCommand}`);
      await execSandbox(
        c,
        sandboxId,
        installCommand,
        remoteWorkdir,
        opts.timeout,
      );
    }

    deployStep(opts, `Starting app on port ${resolvedPort}`);
    await execSandbox(
      c,
      sandboxId,
      `fuser -k ${resolvedPort}/tcp >/dev/null 2>&1 || true; nohup sh -lc ${shellQuote(resolvedStart)} > ${shellQuote(`/tmp/miosa-app-${resolvedPort}.log`)} 2>&1 & echo $!`,
      remoteWorkdir,
    );

    deployStep(opts, "Checking internal app readiness");
    const internal = await waitForInternalHttp(
      c,
      sandboxId,
      resolvedPort,
      resolvedProbePath,
      Math.min(opts.timeout, 60),
    );
    deployStep(opts, "Creating public preview route");
    const exposed = await c.apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/expose`),
      { port: resolvedPort, title: "app preview" },
    );
    const previewUrl = extractUrl(unwrap(exposed));
    if (!previewUrl) {
      throw new UserError("Sandbox expose did not return a preview URL.");
    }

    if (opts.wait) deployStep(opts, "Checking public preview readiness");
    const edge = opts.wait
      ? await waitForPublicPreview(previewUrl, resolvedProbePath, opts.timeout)
      : { ok: false, status: null };

    return {
      sandbox_id: sandboxId,
      port: resolvedPort,
      preview_url: previewUrl,
      preview_ready: edge.ok,
      internal_status: internal.status,
      edge_status: edge.status,
      latency_ms: edge.latency_ms ?? null,
    };
  } catch (err) {
    if (sandboxId) {
      throw new SandboxDeployPartialError(
        err,
        sandboxId,
        recoveryCommandForSandboxDeploy(sandboxId, opts, localDir),
      );
    }
    throw err;
  }
}

const NON_TERMINAL_DEPLOY_STATES = new Set([
  "building",
  "pending",
  "queued",
  "deploying",
]);

// Bug 9: look for an existing non-terminal deployment with a matching name so
// retries attach a new release instead of creating a duplicate app. Defensive:
// returns null (fall back to create) if the list call fails or finds nothing.
async function findExistingDeploymentByName(
  c: ReturnType<typeof client>,
  name: string,
): Promise<{ id: string; state: string } | null> {
  try {
    const raw = unwrap(await c.apiGet<unknown>(apiPath("/deployments")));
    const items = Array.isArray(raw)
      ? raw
      : Array.isArray((asRecord(raw) ?? {})["data"])
        ? ((asRecord(raw) ?? {})["data"] as unknown[])
        : [];
    for (const item of items) {
      const rec = asRecord(item);
      if (!rec) continue;
      if (stringField(rec, "name") !== name) continue;
      const state = (stringField(rec, "state") ?? "").toLowerCase();
      const id = stringField(rec, "id");
      if (id && NON_TERMINAL_DEPLOY_STATES.has(state)) {
        return { id, state };
      }
    }
    return null;
  } catch {
    return null;
  }
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
    metadata: opts.dockerDeploy
      ? { environment: opts.environment, deployment_product: "docker_deploy" }
      : { environment: opts.environment },
  };
  if (opts.dockerDeploy) body["deployment_type"] = "docker-deploy";
  if (opts.app) body["deployment_id"] = opts.app;
  // Bug 9: avoid creating a duplicate deployment on retry. When publishing by
  // name (no explicit app id), reuse an existing non-terminal deployment with
  // the same name by attaching a new release to it.
  if (opts.name && !opts.app) {
    const existing = await findExistingDeploymentByName(c, opts.name);
    if (existing) {
      body["deployment_id"] = existing.id;
      deployStep(
        opts,
        chalk.dim(
          `Attaching to existing deployment ${existing.id} (${existing.state})`,
        ),
      );
    }
  }
  if (opts.name) body["name"] = opts.name;
  if (opts.slug) body["slug"] = opts.slug;
  if (opts.buildCommand) body["build_command"] = opts.buildCommand;
  if (opts.runCommand) body["run_command"] = opts.runCommand;
  if (opts.domain) body["domain"] = opts.domain;
  if (opts.port != null) body["port"] = opts.port;
  const deploymentType = opts.dockerDeploy
    ? "docker-deploy"
    : opts.deploymentType;
  if (deploymentType) body["deployment_type"] = deploymentType;

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
    stringField(response, "version_id") ?? stringField(version, "id") ?? null;
  const releaseId =
    stringField(response, "release_id") ?? stringField(release, "id") ?? null;

  let state =
    stringField(response, "state") ?? stringField(deployment, "state") ?? null;
  let url =
    stringField(response, "url") ??
    extractUrl(deployment) ??
    stringField(data, "url") ??
    null;
  let deploymentProduct =
    stringField(response, "deployment_product") ??
    stringField(data, "deployment_product") ??
    stringField(deployment, "deployment_product") ??
    stringField(asRecord(deployment?.["metadata"]), "deployment_product") ??
    null;
  let dockerDeployHostId =
    stringField(response, "docker_deploy_host_id") ??
    stringField(data, "docker_deploy_host_id") ??
    stringField(deployment, "docker_deploy_host_id") ??
    stringField(asRecord(deployment?.["metadata"]), "docker_deploy_host_id") ??
    null;

  if (opts.wait && deploymentId) {
    deployStep(opts, "Waiting for durable deployment");
    const waited = await waitForDeploymentReady(c, deploymentId, opts.timeout);
    state = stringField(waited, "state") ?? state;
    url = extractUrl(waited) ?? url;
    deploymentProduct =
      stringField(waited, "deployment_product") ??
      stringField(asRecord(waited["metadata"]), "deployment_product") ??
      deploymentProduct;
    dockerDeployHostId =
      stringField(waited, "docker_deploy_host_id") ??
      stringField(asRecord(waited["metadata"]), "docker_deploy_host_id") ??
      dockerDeployHostId;

    response["state"] = state;
    if (url) response["url"] = url;
    data["deployment"] = waited;
    data["promotion_pending"] = false;
    data["app_consistency_pending"] = false;
    if (url) data["url"] = url;
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
    deployment_product: deploymentProduct,
    docker_deploy_host_id: dockerDeployHostId,
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

  const lastState = last ? String(last["state"] ?? "unknown") : "unknown";
  throw new UserError(
    `Deployment still building after ${timeoutSec}s — it may still finish. Re-check with \`miosa sandbox show ${deploymentId}\` or \`miosa deploy logs\`.`,
    `Last state: ${lastState}`,
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
  if (!isJsonMode(opts)) console.error(chalk.dim(`→ ${label}`));
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
    tls:
      edge.error && /tls|certificate|ssl/i.test(edge.error)
        ? "not_ready"
        : previewUrl
          ? "checked"
          : "unknown",
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
  console.log(
    `  ${chalk.bold("Preview ready")} ${report["preview_ready"] ? chalk.green("yes") : chalk.red("no")}`,
  );
  if (report["preview_url"]) {
    console.log(
      `  ${chalk.bold("Preview URL")}   ${chalk.cyan(String(report["preview_url"]))}`,
    );
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

interface SandboxRecoveryReport {
  query: string;
  sandbox: Record<string, unknown> | null;
  sandbox_id: string | null;
  matched_by: "id" | "name" | null;
  exec_ok: boolean;
  app_port: number | null;
  preview_ready: boolean | null;
  preview_url: string | null;
  doctor?: Record<string, unknown> | null;
  recommendations: string[];
  commands: Record<string, string>;
}

async function recoverSandboxDeploy(
  idOrName: string,
  opts: { port?: number; probePath: string },
): Promise<SandboxRecoveryReport> {
  const c = client();
  const resolved = await resolveSandboxForRecovery(c, idOrName);
  if (!resolved.sandbox) {
    return {
      query: idOrName,
      sandbox: null,
      sandbox_id: null,
      matched_by: null,
      exec_ok: false,
      app_port: opts.port ?? null,
      preview_ready: null,
      preview_url: null,
      doctor: null,
      recommendations: [
        "No matching sandbox was found. Run `miosa sandbox list --json` and retry with a sandbox ID.",
      ],
      commands: {
        list: "miosa sandbox list --json",
      },
    };
  }

  const sandbox = resolved.sandbox;
  const sandboxId = str(sandbox["id"]);
  const name = stringOrNull(sandbox["name"]);
  const template = stringOrNull(sandbox["template_id"]);
  const port = opts.port ?? suggestedRecoveryPort(template);

  const execOk = await checkSandboxExec(c, sandboxId);
  const doctor =
    port != null
      ? await safeDoctorSandbox(sandboxId, port, opts.probePath)
      : null;

  const previewUrl = stringOrNull(doctor?.["preview_url"]);
  const previewReady =
    doctor && typeof doctor["preview_ready"] === "boolean"
      ? Boolean(doctor["preview_ready"])
      : null;

  const recommendations = buildRecoveryRecommendations({
    sandbox,
    execOk,
    port,
    previewReady,
    template,
  });

  return {
    query: idOrName,
    sandbox,
    sandbox_id: sandboxId,
    matched_by: resolved.matchedBy,
    exec_ok: execOk,
    app_port: port,
    preview_ready: previewReady,
    preview_url: previewUrl,
    doctor,
    recommendations,
    commands: recoveryCommands(sandboxId, name, port),
  };
}

async function resolveSandboxForRecovery(
  c: ReturnType<typeof client>,
  idOrName: string,
): Promise<{
  sandbox: Record<string, unknown> | null;
  matchedBy: "id" | "name" | null;
}> {
  try {
    const direct = unwrap(
      await c.apiGet<unknown>(apiPath(`/sandboxes/${enc(idOrName)}`)),
    );
    const sandbox = asRecord(direct);
    if (sandbox) return { sandbox, matchedBy: "id" };
  } catch {
    // Fall through to name lookup.
  }

  const list = unwrap(await c.apiGet<unknown>(apiPath("/sandboxes")));
  const items = Array.isArray(list)
    ? list
    : Array.isArray((asRecord(list) ?? {})["data"])
      ? ((asRecord(list) ?? {})["data"] as unknown[])
      : [];

  const matches = items
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => {
      const name = stringOrNull(item["name"]);
      const id = stringOrNull(item["id"]);
      return name === idOrName || id?.startsWith(idOrName);
    })
    .sort((a, b) => {
      const aTime = Date.parse(stringOrNull(a["created_at"]) ?? "") || 0;
      const bTime = Date.parse(stringOrNull(b["created_at"]) ?? "") || 0;
      return bTime - aTime;
    });

  return { sandbox: matches[0] ?? null, matchedBy: matches[0] ? "name" : null };
}

async function checkSandboxExec(
  c: ReturnType<typeof client>,
  sandboxId: string,
): Promise<boolean> {
  try {
    const result = unwrap(
      await c.apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/exec`), {
        command: "pwd",
      }),
    );
    const record = asRecord(result);
    return Number(record?.["exit_code"] ?? 0) === 0;
  } catch {
    return false;
  }
}

async function safeDoctorSandbox(
  sandboxId: string,
  port: number,
  probePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await doctorSandbox(sandboxId, port, probePath);
  } catch (err) {
    return {
      preview_ready: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function suggestedRecoveryPort(template: string | null): number | null {
  if (template === "nextjs" || template === "next-js") return 3000;
  return null;
}

function buildRecoveryRecommendations(input: {
  sandbox: Record<string, unknown>;
  execOk: boolean;
  port: number | null;
  previewReady: boolean | null;
  template: string | null;
}): string[] {
  const recs: string[] = [];
  const state = stringOrNull(input.sandbox["state"]);
  const ready = Boolean(input.sandbox["ready"]);

  if (state !== "running") {
    recs.push(
      `Sandbox state is ${state ?? "unknown"}; wait or recreate before uploading files.`,
    );
  } else if (!ready) {
    recs.push(
      "Sandbox exists but is not fully ready; try exec/write-file before retrying deploy.",
    );
  }

  if (!input.execOk) {
    recs.push("Exec health failed; retry later or recreate the sandbox.");
  } else {
    recs.push(
      "Exec works; if upload/deploy failed, use write-file/patch plus service up.",
    );
  }

  if (input.template === "nextjs" && input.port !== 3000) {
    recs.push(
      "Next.js templates default to port 3000; use 3000 unless you intentionally reconfigured readiness.",
    );
  }

  if (input.port != null && input.previewReady === false) {
    recs.push(
      "Preview is not ready; start the app process, then run sandbox wait.",
    );
  }

  if (input.previewReady === true) {
    recs.push("Preview is ready; publish the sandbox to a durable deployment.");
  }

  return recs;
}

function recoveryCommands(
  sandboxId: string,
  name: string | null,
  port: number | null,
): Record<string, string> {
  const commands: Record<string, string> = {
    health: `miosa sandbox exec ${sandboxId} --json -- pwd`,
    files: `miosa sandbox write-file ${sandboxId} /workspace/app/page.jsx ./page.jsx --json`,
  };

  if (port != null) {
    commands.start = `miosa sandbox service up ${sandboxId} next --cwd /workspace --port ${port} --cmd "npm run dev -- --hostname 0.0.0.0 --port ${port}" --json`;
    commands.wait = `miosa sandbox wait ${sandboxId} --port ${port} --timeout 180 --json`;
    commands.publish = `miosa sandbox publish ${sandboxId} --path /workspace --name ${shellArg(name ?? "Recovered app")} --build-command "npm run build" --run-command "npm run start" --port ${port} --wait --timeout 900s --json`;
  }

  return commands;
}

function renderRecoverReport(report: SandboxRecoveryReport): void {
  if (!report.sandbox_id) {
    console.log(chalk.red("No matching sandbox found."));
    console.log(`  ${report.commands["list"]}`);
    return;
  }

  console.log(chalk.bold("Sandbox recovery"));
  console.log();
  console.log(`  ${chalk.bold("Sandbox")} ${report.sandbox_id}`);
  console.log(`  ${chalk.bold("Matched")} ${report.matched_by}`);
  console.log(
    `  ${chalk.bold("Exec")}    ${report.exec_ok ? chalk.green("ok") : chalk.red("failed")}`,
  );
  if (report.app_port != null) {
    console.log(`  ${chalk.bold("Port")}    ${report.app_port}`);
  }
  if (report.preview_url) {
    console.log(`  ${chalk.bold("Preview")} ${chalk.cyan(report.preview_url)}`);
  }
  if (report.preview_ready != null) {
    console.log(
      `  ${chalk.bold("Ready")}   ${report.preview_ready ? chalk.green("yes") : chalk.yellow("no")}`,
    );
  }
  console.log();
  for (const rec of report.recommendations) {
    console.log(`  - ${rec}`);
  }
  console.log();
  console.log(chalk.bold("Next commands"));
  for (const [label, command] of Object.entries(report.commands)) {
    console.log(`  ${chalk.dim(label.padEnd(7))} ${command}`);
  }
}

async function createSandboxForDeploy(
  c: ReturnType<typeof client>,
  template: string,
  name?: string,
  source?: { source?: string; revision?: string; depth?: number },
): Promise<string> {
  const body: Record<string, unknown> = { template_id: template };
  if (name) body["name"] = name;
  if (source?.source) body["source"] = source.source;
  if (source?.revision) body["revision"] = source.revision;
  if (source?.depth != null) body["depth"] = source.depth;
  const created = unwrap(
    await c.apiPost<unknown>(apiPath("/sandboxes"), body),
  ) as Record<string, unknown>;
  const sandboxId = typeof created["id"] === "string" ? created["id"] : "";
  if (!sandboxId) throw new UserError("Sandbox create did not return an id.");
  return sandboxId;
}

async function readRemoteAppManifest(
  c: ReturnType<typeof client>,
  sandboxId: string,
  timeoutSec: number,
): Promise<MiosaAppManifest | null> {
  const deadline = Date.now() + Math.min(timeoutSec, 120) * 1000;
  while (Date.now() < deadline) {
    for (const filename of [
      "miosa.app.yml",
      "miosa.app.yaml",
      "miosa.app.json",
    ]) {
      const result = await c
        .apiPost<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}/exec`), {
          command: `test -f /workspace/${filename} && cat /workspace/${filename}`,
          cwd: "/workspace",
          timeout: 10,
        })
        .then(unwrap)
        .catch(() => null);
      const row = asRecord(result);
      if (
        Number(row?.["exit_code"] ?? 1) === 0 &&
        typeof row?.["stdout"] === "string"
      ) {
        return parseAppManifest(filename, row["stdout"]);
      }
    }
    await sleep(1500);
  }
  return null;
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
    const state = String(
      sandbox["state"] ?? sandbox["status"] ?? "",
    ).toLowerCase();
    if (state === "running" || state === "active") return sandbox;
    if (state === "error" || state === "failed") {
      throw sandboxStateError(sandboxId, sandbox, state);
    }
    if (state === "destroyed") {
      throw sandboxStateError(sandboxId, sandbox, state);
    }
    await sleep(1500);
  }
  throw new UserError(
    `Sandbox ${sandboxId} did not become running within ${timeoutSec}s.`,
  );
}

async function resumeSandboxAndPrint(
  sandboxId: string,
  opts: JsonOptions,
): Promise<void> {
  try {
    await postAndPrint(`/sandboxes/${enc(sandboxId)}/resume`, opts, {});
  } catch (err) {
    if (err instanceof ApiResponseError && err.code === "SANDBOX_NOT_PAUSED") {
      throw await enrichSandboxLifecycleError(sandboxId, err);
    }
    throw err;
  }
}

async function preflightSandboxConnector(
  sandboxId: string,
  params: {
    provider: string;
    connector?: string;
    model?: string;
    cwd?: string;
  },
): Promise<void> {
  await client().apiPost<unknown>(
    apiPath(`/sandboxes/${enc(sandboxId)}/connectors/preflight`),
    {
      provider: params.provider,
      connector: params.connector,
      model: params.model,
      cwd: params.cwd,
    },
  );
}

async function postSandboxExecAndPrint(
  sandboxId: string,
  opts: JsonOptions,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const value = unwrap(
      await client().apiPost<unknown>(
        apiPath(`/sandboxes/${enc(sandboxId)}/exec`),
        body,
      ),
    );
    printValue(value, opts);
  } catch (err) {
    if (err instanceof ApiResponseError && err.code === "SANDBOX_NOT_RUNNING") {
      throw await enrichSandboxLifecycleError(sandboxId, err);
    }
    throw err;
  }
}

async function enrichSandboxLifecycleError(
  sandboxId: string,
  err: ApiResponseError,
): Promise<ApiResponseError> {
  let sandbox: Record<string, unknown> | null = null;
  try {
    sandbox = unwrap(
      await client().apiGet<unknown>(apiPath(`/sandboxes/${enc(sandboxId)}`)),
    ) as Record<string, unknown>;
  } catch {
    // Preserve the original API error when the follow-up lookup is unavailable.
  }

  if (!sandbox) return err;

  const state = String(sandbox["state"] ?? sandbox["status"] ?? "unknown");
  const details = sandboxLifecycleDetails(sandbox);
  const message =
    state === "destroyed"
      ? `Sandbox ${sandboxId} is destroyed, not paused. It cannot be resumed.`
      : `${err.message}. Current sandbox state: ${state}.`;

  return new ApiResponseError(
    err.code,
    message,
    EXIT_USER_ERROR,
    false,
    sandboxRecoveryHint(sandboxId, sandbox),
    details,
    err.requestId,
  );
}

function sandboxStateError(
  sandboxId: string,
  sandbox: Record<string, unknown>,
  state: string,
): UserError {
  const reason = sandboxLastErrorReason(sandbox);
  const message =
    state === "destroyed"
      ? `Sandbox ${sandboxId} is destroyed, not paused. It cannot be resumed.`
      : `Sandbox ${sandboxId} entered ${state} state${reason ? `: ${reason}` : ""}.`;

  return new UserError(message, sandboxRecoveryHint(sandboxId, sandbox));
}

function sandboxRecoveryHint(
  sandboxId: string,
  sandbox: Record<string, unknown>,
): string {
  const state = String(sandbox["state"] ?? sandbox["status"] ?? "unknown");
  const name = String(sandbox["name"] ?? "new-sandbox");
  const template = String(sandbox["template_id"] ?? "nextjs");
  const timeoutRemainingSec = timeoutRemainingSeconds(sandbox);

  if (
    state === "running" &&
    timeoutRemainingSec != null &&
    timeoutRemainingSec <= EXPIRING_SANDBOX_THRESHOLD_SEC
  ) {
    return `Sandbox expires soon. Extend it with: miosa sandbox extend ${sandboxId} --timeout 1h`;
  }

  if (state === "paused") {
    return `Resume it with: miosa sandbox resume ${sandboxId}`;
  }

  if (state === "destroyed") {
    return `Create a replacement with: miosa sandbox create --template ${template} --name ${shellQuote(name)} --timeout 1h --wait --json`;
  }

  if (state === "error" || state === "failed") {
    return `Inspect recovery with: miosa sandbox recover ${sandboxId}`;
  }

  return `Inspect it with: miosa sandbox show ${sandboxId} --json`;
}

function sandboxLifecycleDetails(
  sandbox: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sandbox_id: sandbox["id"],
    name: sandbox["name"],
    state: sandbox["state"] ?? sandbox["status"],
    timeout_sec: sandbox["timeout_sec"],
    timeout_remaining_ms: sandbox["timeout_remaining_ms"],
    destroyed_at: sandbox["destroyed_at"],
    last_error: sandboxLastError(sandbox),
  };
}

function sandboxLastErrorReason(
  sandbox: Record<string, unknown>,
): string | null {
  const lastError = sandboxLastError(sandbox);
  if (!lastError) return null;
  const reason = lastError["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

function sandboxLastError(
  sandbox: Record<string, unknown>,
): Record<string, unknown> | null {
  const metadata = sandbox["metadata"];
  if (!metadata || typeof metadata !== "object") return null;
  const lastError = (metadata as Record<string, unknown>)["last_error"];
  return lastError && typeof lastError === "object"
    ? (lastError as Record<string, unknown>)
    : null;
}

function timeoutRemainingSeconds(
  sandbox: Record<string, unknown>,
): number | null {
  const ms = sandbox["timeout_remaining_ms"];
  if (typeof ms === "number") return Math.ceil(ms / 1000);
  const sec = sandbox["timeout_remaining_sec"];
  return typeof sec === "number" ? sec : null;
}

/**
 * Prints a yellow expiry warning when a running sandbox has <5 minutes left.
 * Call this in any non-JSON render path that shows sandbox state.
 */
function warnIfExpiringSoon(
  sandbox: Record<string, unknown>,
  sandboxId: string,
): void {
  const state = String(
    sandbox["state"] ?? sandbox["status"] ?? "",
  ).toLowerCase();
  if (state !== "running" && state !== "active") return;
  const remainingSec = timeoutRemainingSeconds(sandbox);
  if (remainingSec == null || remainingSec > EXPIRING_SANDBOX_THRESHOLD_SEC)
    return;

  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const humanTime =
    mins > 0 ? `${mins}m${secs > 0 ? `${secs}s` : ""}` : `${secs}s`;

  console.log(
    chalk.yellow(
      `  Warning: Sandbox expires in ${humanTime}. Extend: miosa sandbox extend ${sandboxId} --timeout 1h`,
    ),
  );
  console.log();
}

function createDeployArchive(sourceDir: string): string {
  const archivePath = path.join(
    os.tmpdir(),
    `miosa-deploy-${process.pid}-${Date.now()}.tgz`,
  );
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
): Promise<unknown> {
  return writeBytesToSandbox(
    c,
    sandboxId,
    remotePath,
    fs.readFileSync(localPath),
  );
}

async function writeBytesToSandbox(
  c: ReturnType<typeof client>,
  sandboxId: string,
  remotePath: string,
  bytes: Buffer,
): Promise<unknown> {
  try {
    return await c.apiPost(apiPath(`/sandboxes/${enc(sandboxId)}/files`), {
      path: remotePath,
      content: bytes.toString("base64"),
    });
  } catch (err) {
    if (!shouldFallbackSandboxUpload(err)) throw err;
    await writeBytesToSandboxViaExec(c, sandboxId, remotePath, bytes);
    return {
      data: {
        sandbox_id: sandboxId,
        path: remotePath,
        size: bytes.length,
        transport: "exec_chunked_fallback",
      },
    };
  }
}

async function writeBytesToSandboxViaExec(
  c: ReturnType<typeof client>,
  sandboxId: string,
  remotePath: string,
  bytes: Buffer,
): Promise<void> {
  const base64 = bytes.toString("base64");
  const base64Path = `${remotePath}.b64`;
  const chunkSize = 48_000;

  await execSandbox(
    c,
    sandboxId,
    `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && rm -f ${shellQuote(remotePath)} ${shellQuote(base64Path)}`,
    "/",
  );

  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    const chunk = base64.slice(offset, offset + chunkSize);
    await execSandbox(
      c,
      sandboxId,
      `printf '%s' ${shellQuote(chunk)} >> ${shellQuote(base64Path)}`,
      "/",
    );
  }

  await execSandbox(
    c,
    sandboxId,
    `base64 -d ${shellQuote(base64Path)} > ${shellQuote(remotePath)} && rm -f ${shellQuote(base64Path)}`,
    "/",
  );
}

function shouldFallbackSandboxUpload(err: unknown): boolean {
  if (err instanceof NetworkError || err instanceof ServerError) return true;
  if (err instanceof ApiResponseError) {
    return (
      err.retryable ||
      /AGENT_UNAVAILABLE|SANDBOX_FILE_AGENT_UNAVAILABLE/i.test(err.code)
    );
  }
  if (err instanceof Error) {
    return /fetch failed|ECONNRESET|HTTP 502|AGENT_UNAVAILABLE|other side closed|socket hang up/i.test(
      err.message,
    );
  }
  return false;
}

function recoveryCommandForSandboxDeploy(
  sandboxId: string,
  opts: SandboxDeployOptions,
  localDir: string,
): string {
  const parts = [
    "miosa",
    "sandbox",
    "deploy",
    shellQuote(localDir),
    "--sandbox",
    shellQuote(sandboxId),
  ];
  if (opts.port != null) parts.push("--port", String(opts.port));
  if (opts.publishPort != null)
    parts.push("--publish-port", String(opts.publishPort));
  if (opts.installCommand)
    parts.push("--install-command", shellQuote(opts.installCommand));
  if (opts.install === false) parts.push("--no-install");
  if (opts.start) parts.push("--start", shellQuote(opts.start));
  if (opts.wait) parts.push("--wait");
  if (opts.timeout != null) parts.push("--timeout", `${opts.timeout}s`);
  if (opts.probePath) parts.push("--probe-path", shellQuote(opts.probePath));
  return parts.join(" ");
}

function handleSandboxDeployError(err: unknown, opts: JsonOptions): never {
  if (err instanceof SandboxDeployPartialError) {
    const cause = err.causeError;
    const message = cause instanceof Error ? cause.message : String(cause);
    const retryable =
      cause instanceof ApiResponseError
        ? cause.retryable
        : shouldFallbackSandboxUpload(cause);

    if (isJsonMode(opts)) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: errorCodeForDeployCause(cause),
              message,
              retryable,
              ...(cause instanceof MiosaError && cause.requestId
                ? { request_id: cause.requestId }
                : {}),
            },
            partial_resource: {
              type: "sandbox",
              id: err.sandboxId,
              recovery_command: err.recoveryCommand,
            },
          },
          null,
          2,
        ),
      );
      return process.exit(1);
    }

    console.error(chalk.red(`Error: ${message}`));
    console.error(
      chalk.yellow(
        `Sandbox ${err.sandboxId} exists. Retry into it with:\n  ${err.recoveryCommand}`,
      ),
    );
    return process.exit(1);
  }

  handleError(err);
}

function errorCodeForDeployCause(err: unknown): string {
  if (err instanceof ApiResponseError) return err.code;
  if (err instanceof NetworkError) return "NETWORK";
  if (err instanceof ServerError) return "SERVER";
  if (err instanceof MiosaError) return err.constructor.name.toUpperCase();
  if (err instanceof Error && /fetch failed|ECONNRESET/i.test(err.message))
    return "NETWORK";
  return "UNEXPECTED_ERROR";
}

async function uploadDirToSandbox(
  sandboxId: string,
  localDir: string,
  remoteDir: string,
  opts: { delete: boolean },
): Promise<{
  sandbox_id: string;
  local_dir: string;
  remote_dir: string;
  files_label: string;
}> {
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
    await c.apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/exec`),
      body,
    ),
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

// Like execSandbox but does NOT throw on a non-zero exit code.
async function execSandboxRaw(
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
  return unwrap(
    await c.apiPost<unknown>(
      apiPath(`/sandboxes/${enc(sandboxId)}/exec`),
      body,
    ),
  ) as Record<string, unknown>;
}

interface PortBinding {
  port: number;
  address: string;
  protocol?: string;
  state?: string;
  process?: {
    name?: string;
    pid?: number;
  } | null;
}

function sandboxPortsFromResponse(raw: unknown): PortBinding[] {
  const root = unwrap(raw);
  if (Array.isArray(root)) return root as PortBinding[];
  if (root && typeof root === "object") {
    const row = root as Record<string, unknown>;
    if (Array.isArray(row["ports"])) return row["ports"] as PortBinding[];
    if (Array.isArray(row["data"])) return row["data"] as PortBinding[];
  }
  return [];
}

function renderResourceMetrics(title: string, raw: unknown): void {
  const root = unwrap(raw);
  if (!root || typeof root !== "object") {
    printValue(root, {});
    return;
  }

  const row = root as Record<string, unknown>;
  const current =
    row["current"] && typeof row["current"] === "object"
      ? (row["current"] as Record<string, unknown>)
      : {};

  printBanner({ subtitle: title });
  console.log(
    kvPanel([
      {
        label: "resource_id",
        value: String(row["resource_id"] ?? row["sandbox_id"] ?? "-"),
      },
      { label: "window", value: String(row["window"] ?? "1h") },
      { label: "state", value: formatState(current["state"]) },
      { label: "ready", value: formatBool(current["ready"]) },
      { label: "cpu", value: formatMaybe(current["cpu_count"]) },
      { label: "memory", value: formatMb(current["memory_mb"]) },
      { label: "disk", value: formatMb(current["disk_size_mb"]) },
      { label: "uptime", value: formatSeconds(current["uptime_sec"]) },
      {
        label: "timeout_remaining",
        value: formatSecondsOrAlwaysOn(current["timeout_remaining_sec"]),
      },
      { label: "node", value: formatMaybe(current["node_id"]) },
      { label: "ip", value: formatMaybe(current["ip_address"]) },
      { label: "boot", value: formatMs(current["boot_ms"]) },
      { label: "envd_ready", value: formatMs(current["envd_ready_ms"]) },
    ]),
  );
}

function formatState(value: unknown): string {
  const state = String(value ?? "unknown");
  if (["running", "active", "healthy", "ready"].includes(state)) {
    return chalk.green(state);
  }
  if (["provisioning", "starting", "building", "pending"].includes(state)) {
    return chalk.yellow(state);
  }
  if (["failed", "error", "unhealthy"].includes(state)) {
    return chalk.red(state);
  }
  return state;
}

function formatBool(value: unknown): string {
  if (value === true) return chalk.green("true");
  if (value === false) return chalk.red("false");
  return chalk.dim("-");
}

function formatMaybe(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return chalk.dim("-");
  return String(value);
}

function formatMb(value: unknown): string {
  if (typeof value !== "number") return formatMaybe(value);
  return formatBytes(value * 1024 * 1024);
}

function formatMs(value: unknown): string {
  if (typeof value !== "number") return formatMaybe(value);
  return `${value}ms`;
}

function formatSeconds(value: unknown): string {
  if (typeof value !== "number") return formatMaybe(value);
  return formatDuration(value * 1000);
}

function formatSecondsOrAlwaysOn(value: unknown): string {
  if (value === null || value === undefined) return chalk.dim("always-on/none");
  return formatSeconds(value);
}

// Stream exec output: run in background to a log file, poll-read new bytes
// until the process exits, then print the final exit code.
async function runFollowExec(
  sandboxId: string,
  cmd: string,
  cwd: string | undefined,
  env: Record<string, string>,
  timeoutSec: number | undefined,
  opts: JsonOptions,
): Promise<void> {
  if (!cmd) {
    throw new UserError("No command given to follow.");
  }
  const c = client();
  const logPath = `/tmp/miosa-follow-${Date.now()}.log`;
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)} `)
    .join("");
  // Run command, capture exit code into a sentinel file, in the background.
  const exitPath = `${logPath}.exit`;
  const inner = `${envPrefix}${cmd}`;
  const launch = `nohup sh -lc ${shellQuote(
    `( ${inner} ) > ${shellQuote(logPath)} 2>&1; echo $? > ${shellQuote(exitPath)}`,
  )} >/dev/null 2>&1 & echo $!`;
  const started = await execSandboxRaw(c, sandboxId, launch, cwd, timeoutSec);
  const pid = String(started["stdout"] ?? "").trim();
  if (!pid) {
    throw new UserError("Could not start background command for --follow.");
  }

  const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : Infinity;
  let offset = 0;
  for (;;) {
    const read = await execSandboxRaw(
      c,
      sandboxId,
      `tail -c +${offset + 1} ${shellQuote(logPath)} 2>/dev/null`,
    );
    const chunk = String(read["stdout"] ?? "");
    if (chunk.length > 0) {
      process.stdout.write(chunk);
      offset += Buffer.byteLength(chunk);
    }
    const alive = await execSandboxRaw(
      c,
      sandboxId,
      `kill -0 ${shellQuote(pid)} 2>/dev/null && echo alive || echo done`,
    );
    if (String(alive["stdout"] ?? "").trim() === "done") break;
    if (Date.now() > deadline) {
      console.error(
        chalk.yellow(
          `\nTimed out after ${timeoutSec}s — command may still be running (pid ${pid}).`,
        ),
      );
      return;
    }
    await sleep(1000);
  }
  // Drain any trailing output.
  const tail = await execSandboxRaw(
    c,
    sandboxId,
    `tail -c +${offset + 1} ${shellQuote(logPath)} 2>/dev/null`,
  );
  const tailChunk = String(tail["stdout"] ?? "");
  if (tailChunk.length > 0) process.stdout.write(tailChunk);

  const exitRead = await execSandboxRaw(
    c,
    sandboxId,
    `cat ${shellQuote(exitPath)} 2>/dev/null`,
  );
  const exitCode = Number(String(exitRead["stdout"] ?? "0").trim() || "0");
  if (!isJsonMode(opts) && exitCode !== 0) {
    console.error(chalk.red(`\nexit code: ${exitCode}`));
  }
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
    const status = Number(
      String(result["stdout"] ?? "")
        .trim()
        .split(/\s+/)[0],
    );
    return {
      ok: Number.isFinite(status) && status >= 200 && status < 400,
      status,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
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
    last.error ??
      (last.status ? `Last HTTP status: ${last.status}` : undefined),
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
      ok:
        (res.status >= 200 && res.status < 400) ||
        res.status === 401 ||
        res.status === 403,
      status: res.status,
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
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
    last.error ??
      (last.status ? `Last HTTP status: ${last.status}` : undefined),
  );
}

function defaultInstallCommand(sourceDir: string): string | null {
  if (fs.existsSync(path.join(sourceDir, "package.json"))) return "npm install";
  if (fs.existsSync(path.join(sourceDir, "requirements.txt")))
    return "pip install -r requirements.txt";
  return null;
}

function defaultStartCommand(
  framework: string | undefined,
  port: number,
): string {
  if (framework === "nextjs") return `npm run dev -- -H 0.0.0.0 -p ${port}`;
  if (framework === "vite-react")
    return `npm run dev -- --host 0.0.0.0 --port ${port}`;
  if (framework === "static")
    return `python3 -m http.server ${port} --bind 0.0.0.0`;
  return `npm run dev -- --host 0.0.0.0 --port ${port}`;
}

function normalizeRemoteWorkdir(value: string): string {
  if (!value || value === ".") return "/workspace";
  if (!value.startsWith("/")) return `/workspace/${value.replace(/^\.\//, "")}`;
  return value;
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

function parseSandboxTarget(target: string): {
  sandboxId: string;
  remotePath: string;
} {
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
    const localArchive = path.join(
      os.tmpdir(),
      `miosa-copy-${process.pid}-${Date.now()}.tgz`,
    );
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
      await execSandbox(
        c,
        sandboxId,
        `rm -f ${shellQuote(remoteArchive)}`,
        "/",
      ).catch(() => ({}));
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
    return Buffer.from(
      (data as Record<string, unknown>)["content"] as string,
      "base64",
    );
  }
  throw new UserError(`Could not read sandbox file: ${remotePath}`);
}

function commandInCwd(command: string, cwd?: string): string {
  if (!cwd) return command;
  return `cd ${shellQuote(cwd)} && ${command}`;
}

function supportedRunAgentRunners(): string[] {
  return [
    "claude",
    "claude-code",
    "codex",
    "pi",
    "hermes",
    "osa",
    "custom",
  ];
}

function runtimeCommandForRunner(
  runner: string,
  runtimeCommand?: string,
): string | null {
  const normalized = runner.trim().toLowerCase();
  if (normalized === "custom") {
    if (!runtimeCommand?.trim()) {
      throw new Error(
        "--runner custom requires --runtime-command, e.g. --runtime-command 'hermes-agent run'",
      );
    }
    return runtimeCommand.trim();
  }

  const builtIns: Record<string, string> = {
    claude: "claude",
    "claude-code": "claude",
    codex: "codex",
    pi: "pi",
    hermes: "hermes",
    osa: "osa",
  };

  return builtIns[normalized] ?? null;
}

function isSupportedRunAgentRunner(runner: string): boolean {
  return supportedRunAgentRunners().includes(runner.trim().toLowerCase());
}

function backgroundCommand(command: string): string {
  if (!command.trim()) return command;
  const logPath = `/tmp/miosa-bg-${Date.now()}.log`;
  return `nohup sh -lc ${shellQuote(command)} > ${shellQuote(logPath)} 2>&1 & echo $!`;
}

function resolveSandboxCommand(
  words: string[],
  opts: { cmd?: string; command?: string; shellCmd?: string },
): string {
  const positional =
    words.length === 1 ? (words[0] ?? "") : joinCommandWords(words);
  const cmd = opts.cmd ?? opts.command ?? positional;
  if (!opts.shellCmd) return cmd;
  if (!cmd.trim()) return opts.shellCmd;
  return `${opts.shellCmd} ${shellQuote(cmd)}`;
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
  const match = String(value)
    .trim()
    .match(/^(\d+)(ms|s|m|h|d)?$/i);
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
  const match = String(value)
    .trim()
    .match(/^(\d+)(mb|m|gb|g)?$/i);
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

// Join argv words back into a shell command, quoting only words that contain
// whitespace or shell-significant characters. Simple tokens stay bare so
// `exec <id> ls -la` reads naturally, while `bash -c "cd x && y"` survives.
function joinCommandWords(words: string[]): string {
  const SAFE = /^[A-Za-z0-9_./:=@%+-]+$/;
  return words
    .map((word) =>
      word.length > 0 && SAFE.test(word) ? word : shellQuote(word),
    )
    .join(" ");
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

// Sandbox render helpers

/** Coerce an unknown API field to a display string. */
function str(v: unknown): string {
  if (v === null || v === undefined) return chalk.dim("-");
  return String(v);
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
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
  warnIfExpiringSoon(sb, id);
  console.log(
    hintBlock("Next", [
      `miosa sandbox show ${id}`,
      `miosa sandbox exec ${id} --command 'python -c print(2+2)'`,
    ]),
  );
  printElapsed(formatDuration(elapsedMs));
}
