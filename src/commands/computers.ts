import type { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import chalk from "chalk";
import {
  addDataOption,
  apiPath,
  client,
  deleteAndPrint,
  enc,
  getAndPrint,
  parseData,
  postAndPrint,
  printValue,
  resourceCommands,
  runAction,
  unwrap,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { isJsonMode } from "../cli-env.js";
import { MiosaClient, parseSse } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { toComputerId } from "../types.js";
import { parseEnvPairs } from "./util.js";
import { pickOne } from "../ui/picker.js";
import { spin } from "../ui/spinner.js";
import {
  formatDuration,
  hintBlock,
  icon,
  kvPanel,
  printBanner,
  printElapsed,
} from "../ui/render.js";
import { renderTable } from "../ui/table.js";

const actions = [
  "start",
  "stop",
  "restart",
  "clone",
  "resize",
  "move",
] as const;

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

function colorStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "running") return chalk.green(status);
  if (s === "provisioning" || s === "starting" || s === "pending")
    return chalk.yellow(status);
  if (s === "error" || s === "failed" || s === "stopped")
    return chalk.red(status);
  return chalk.dim(status || "—");
}

function friendlyComputerType(record: Record<string, unknown>): string {
  const template = String(
    record["template_type"] ?? record["template"] ?? "",
  ).toLowerCase();
  return template.includes("desktop") ? "Desktop" : "Computer";
}

async function promptForComputerDetails(): Promise<{
  name: string;
  size: string;
  region: string;
}> {
  const { default: inquirer } = await import("inquirer");
  return inquirer.prompt<{
    name: string;
    size: string;
    region: string;
  }>([
    {
      type: "input",
      name: "name",
      message: "What should we call your computer?",
      default: "my-computer",
      validate: (value: string) =>
        value.trim().length > 0 || "Enter a name for your computer.",
      filter: (value: string) => value.trim(),
    },
    {
      type: "list",
      name: "size",
      message: "Choose a size",
      default: "small",
      choices: [
        { name: "Small   Everyday development", value: "small" },
        { name: "Medium  Larger builds and multitasking", value: "medium" },
        { name: "Large   Heavy workloads", value: "large" },
      ],
    },
    {
      type: "list",
      name: "region",
      message: "Choose a location",
      default: "us-mia",
      choices: [
        { name: "Miami", value: "us-mia" },
        { name: "New York", value: "us-nyc" },
        { name: "Los Angeles", value: "us-la" },
      ],
    },
  ]);
}

async function resolveComputerForDesktop(
  requested?: string,
): Promise<Record<string, unknown>> {
  const raw = unwrap<unknown>(
    await client().apiGet<unknown>(apiPath("/computers")),
  );
  const computers = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : [];
  const available = computers.filter((computer) =>
    ["running", "active", "provisioning", "starting", "pending"].includes(
      String(computer["status"] ?? "").toLowerCase(),
    ),
  );

  if (requested) {
    const normalized = requested.toLowerCase();
    const match = computers.find(
      (computer) =>
        String(computer["id"] ?? "").toLowerCase() === normalized ||
        String(computer["name"] ?? "").toLowerCase() === normalized,
    );
    if (!match) {
      throw new UserError(
        `Computer "${requested}" was not found.`,
        "Run `miosa computers list` to see available computers.",
      );
    }
    if (!available.includes(match)) {
      throw new UserError(
        `Computer "${requested}" is not running.`,
        `Start it with \`miosa computers action ${String(match["id"])} start\`.`,
      );
    }
    return match;
  }

  const picked = await pickOne(
    available.map((computer) => ({
      id: String(computer["id"] ?? ""),
      label: String(computer["name"] ?? computer["id"] ?? "Unnamed computer"),
      hint: [
        String(computer["status"] ?? ""),
        String(computer["region"] ?? ""),
        String(computer["size"] ?? ""),
      ]
        .filter(Boolean)
        .join(" · "),
      data: computer,
    })),
    "Which desktop would you like to open?",
  );
  return picked.data;
}

async function waitUntilDesktopReady(
  computer: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ready = new Set(["running", "active"]);
  const transitional = new Set(["provisioning", "starting", "pending"]);
  let current = computer;
  let status = String(current["status"] ?? "").toLowerCase();
  if (ready.has(status)) return current;
  if (!transitional.has(status)) return current;

  const name = String(current["name"] ?? current["id"] ?? "computer");
  const spinner = spin(`Preparing ${name}...`);
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    await sleep(2_000);
    current = unwrap<Record<string, unknown>>(
      await client().apiGet<unknown>(
        apiPath(`/computers/${enc(String(computer["id"]))}`),
      ),
    );
    status = String(current["status"] ?? "").toLowerCase();
    if (ready.has(status)) {
      spinner.succeed(`${name} is ready`);
      return current;
    }
    if (!transitional.has(status)) {
      spinner.fail(`${name} entered status ${status || "unknown"}`);
      throw new UserError(
        `Computer "${name}" did not become ready.`,
        `Inspect it with \`miosa computers show ${String(computer["id"])}\`.`,
      );
    }
  }

  spinner.fail(`${name} is still preparing`);
  throw new UserError(
    `Computer "${name}" is taking longer than expected to start.`,
    `Check it with \`miosa computers show ${String(computer["id"])}\`, then run \`miosa computers open ${name}\` again.`,
  );
}

async function openComputerDesktop(
  requested: string | undefined,
  opts: { printUrl?: boolean; json?: boolean },
): Promise<void> {
  const selected = await resolveComputerForDesktop(requested);
  const computer = await waitUntilDesktopReady(selected);
  const id = String(computer["id"]);
  const name = String(computer["name"] ?? id);
  const access = unwrap<Record<string, unknown>>(
    await client().apiGet<unknown>(
      apiPath(`/computers/${enc(id)}/embed`),
    ),
  );
  const url = String(access["embed_url"] ?? access["desktop_url"] ?? "");
  if (!url) {
    throw new UserError(
      `MIOSA could not prepare desktop access for "${name}".`,
      `Check it with \`miosa computers show ${id}\` and try again.`,
    );
  }

  if (isJsonMode(opts)) {
    console.log(
      JSON.stringify(
        {
          id,
          name,
          url,
          expires_at: access["expires_at"] ?? null,
          password_required: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (opts.printUrl) {
    console.log(url);
    return;
  }

  openUrl(url);
  console.log();
  console.log(`  ${icon.ok}  Opening ${chalk.bold(name)} in your browser`);
  console.log();
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function isTerminalRunStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    ["succeeded", "failed", "canceled", "cancelled"].includes(status.toLowerCase())
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForComputerRun(
  runId: string,
  timeoutSec: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSec * 1000;

  while (true) {
    const run = unwrap<Record<string, unknown>>(
      await client().apiGet<unknown>(apiPath(`/runs/${enc(runId)}`)),
    );

    if (isTerminalRunStatus(run["status"])) return run;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for run ${runId}`);
    }

    await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }
}

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "computers",
    description:
      "Manage Computers (Firecracker microVMs with optional desktops)",
    route: "/computers",
    itemName: "computer-id",
    actions,
    // list, show, and create are registered below with styled overrides.
    skipCommands: ["list", "show", "create"],
  });

  const computers = program.commands.find((cmd) => cmd.name() === "computers");

  // Back-compat alias: `miosa machines` continues to work for one release.
  computers!.alias("machines");

  // Workspace-aware list (skipped in resourceCommands via skipCommands).
  computers!
    .command("list")
    .description("List computers, optionally filtered to a workspace")
    .option("--workspace <workspace-id>", "Filter by workspace ID")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions & { workspace?: string }) =>
      runAction(async () => {
        const url = new URL(
          apiPath("/computers"),
          "https://placeholder.invalid",
        );
        if (opts.workspace)
          url.searchParams.set("workspace_id", opts.workspace);
        const path = url.pathname + (url.search ? url.search : "");

        const raw = unwrap<unknown>(
          await client().apiGet<unknown>(apiPath(path)),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }

        const rows: Record<string, unknown>[] = Array.isArray(raw)
          ? (raw as Record<string, unknown>[])
          : [];

        console.log();
        if (rows.length === 0) {
          console.log(
            kvPanel([
              {
                icon: icon.info,
                label: "Computers",
                value: chalk.dim("0  — none created yet"),
              },
            ]),
          );
          console.log();
          console.log(
            hintBlock("Create your first computer", [
              "miosa computers create",
              "miosa computers create --name boris",
            ]),
          );
          console.log();
          return;
        }

        console.log(
          `  ${icon.info}  ${chalk.bold(String(rows.length))} ${chalk.dim("computer(s)")}`,
        );
        console.log();

        renderTable(rows, [
          {
            header: "ID",
            key: (r) => String(r["id"] ?? ""),
            width: 12,
          },
          {
            header: "NAME",
            key: (r) => String(r["name"] ?? chalk.dim("—")),
          },
          {
            header: "STATUS",
            key: (r) => String(r["status"] ?? ""),
            color: (val) => colorStatus(val.trim()),
          },
          {
            header: "TYPE",
            key: (r) => friendlyComputerType(r),
          },
          {
            header: "REGION",
            key: (r) => String(r["region"] ?? chalk.dim("—")),
          },
          {
            header: "CREATED",
            key: (r) => String(r["created_at"] ?? chalk.dim("—")),
          },
        ]);

        console.log();
        console.log(
          hintBlock("Try", [
            "miosa computers show <id>",
            "miosa computers create --name <name>",
          ]),
        );
        console.log();
      }),
    );

  // Styled show (skipped in resourceCommands via skipCommands).
  computers!
    .command("show <computer-id>")
    .description("Show a computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = unwrap<Record<string, unknown>>(
          await client().apiGet<unknown>(apiPath(`/computers/${enc(id)}`)),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }

        const c = raw as Record<string, unknown>;
        const status = String(c["status"] ?? "");

        printBanner({ subtitle: "Computer" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "id",
              value: chalk.dim(String(c["id"] ?? "—")),
            },
            { label: "name", value: chalk.bold(String(c["name"] ?? "—")) },
            { label: "status", value: colorStatus(status) },
            {
              label: "type",
              value: friendlyComputerType(c),
            },
            { label: "size", value: String(c["size"] ?? chalk.dim("—")) },
            { label: "region", value: String(c["region"] ?? chalk.dim("—")) },
            ...(c["ip_address"]
              ? [
                  {
                    label: "ip_address",
                    value: chalk.cyan(String(c["ip_address"])),
                  },
                ]
              : []),
            {
              label: "created_at",
              value: chalk.dim(String(c["created_at"] ?? "—")),
            },
            ...(c["public_url"]
              ? [
                  {
                    label: "public_url",
                    value: chalk.cyan(String(c["public_url"])),
                  },
                ]
              : []),
          ]),
        );
        console.log();
        console.log(
          hintBlock("Try", [
            `miosa computers open ${String(c["name"] ?? id)}`,
            `miosa ssh ${String(c["name"] ?? id)}`,
            `miosa exec ${String(c["name"] ?? id)} "pwd"`,
            `miosa watch ${String(c["name"] ?? id)}`,
            `miosa computers action ${id} stop`,
          ]),
        );
        console.log();
      }),
    );

  computers!
    .command("viewer-password <computer-id>")
    .alias("password")
    .description("Show external desktop viewer-password status")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = unwrap<Record<string, unknown>>(
          await client().apiGet<unknown>(
            apiPath(`/computers/${enc(id)}/viewer-password`),
          ),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }

        printBanner({ subtitle: "External desktop viewer password" });
        console.log(
          kvPanel([
            { icon: icon.info, label: "computer", value: chalk.dim(id) },
            {
              label: "password_set",
              value: raw["password_set"] ? chalk.green("yes") : chalk.yellow("no"),
            },
            ...(raw["viewer_password_set_at"] || raw["password_set_at"]
              ? [
                  {
                    label: "set_at",
                    value: chalk.dim(
                      String(raw["viewer_password_set_at"] ?? raw["password_set_at"]),
                    ),
                  },
                ]
              : []),
          ]),
        );
        console.log();
        console.log(
          hintBlock("Use", [
            `miosa computers rotate-viewer-password ${id}`,
            "Authenticated platform desktop links do not need this password.",
          ]),
        );
        console.log();
      }),
    );

  computers!
    .command("rotate-viewer-password <computer-id>")
    .alias("rotate-password")
    .description("Rotate and print the external desktop viewer password once")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = unwrap<Record<string, unknown>>(
          await client().apiPost<unknown>(
            apiPath(`/computers/${enc(id)}/viewer-password/rotate`),
            {},
          ),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }

        const password = String(raw["viewer_password"] ?? raw["password"] ?? "");
        printBanner({ subtitle: "Rotated external viewer password" });
        console.log(
          kvPanel([
            { icon: icon.ok, label: "computer", value: chalk.dim(id) },
            {
              label: "viewer_password",
              value: password ? chalk.bold(password) : chalk.dim("not returned"),
            },
            ...(raw["rotated_at"]
              ? [{ label: "rotated_at", value: chalk.dim(String(raw["rotated_at"])) }]
              : []),
          ]),
        );
        console.log();
        console.log(
          chalk.yellow(
            "This password is for raw external desktop viewer links. Store it now; it may not be returned again.",
          ),
        );
        console.log();
      }),
    );

  computers!
    .command("run-agent <computer-id> <instruction...>")
    .description("Run an in-Computer runner with the given instruction")
    .option(
      "--runner <name>",
      "Runner: claude-code (default), codex, claude (alias), hermes, osa, pi",
    )
    .option("--model <name>", "Provider-specific model name")
    .option("--cwd <path>", "Working directory inside the Computer")
    .option(
      "--env <KEY=VALUE>",
      "Environment variable for the run. Repeatable.",
      collectOption,
      [],
    )
    .option("--timeout <sec>", "Exec timeout in seconds")
    .option("--wait", "Wait for run completion")
    .option("--wait-timeout <sec>", "Maximum seconds to wait for --wait")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        words: string[],
        opts: {
          runner?: string;
          model?: string;
          cwd?: string;
          env?: string[];
          timeout?: string;
          wait?: boolean;
          waitTimeout?: string;
        } & JsonOptions,
      ) =>
        runAction(async () => {
          const runner = opts.runner ?? "claude-code";
          const allowedRunners = [
            "claude-code",
            "codex",
            "claude",
            "hermes",
            "osa",
            "pi",
          ];
          if (!allowedRunners.includes(runner)) {
            throw new Error(
              `Unsupported runner "${runner}". Use: ${allowedRunners.join(", ")}`,
            );
          }

          const body: Record<string, unknown> = {
            target_kind: "computer",
            target_id: id,
            computer_id: id,
            runner,
            instruction: words.join(" "),
          };
          if (opts.model) body["model"] = opts.model;
          if (opts.cwd) body["cwd"] = opts.cwd;
          if (opts.env && opts.env.length > 0) {
            body["env"] = parseEnvPairs(opts.env);
          }
          if (opts.timeout != null) {
            body["timeout"] = Number.parseInt(opts.timeout, 10);
          }
          if (opts.wait) body["wait"] = true;

          let run = unwrap<Record<string, unknown>>(
            await client().apiPost<unknown>(apiPath("/runs"), body),
          );

          if (opts.wait) {
            const runId = String(run["id"] ?? "");
            const waitTimeout = Number.parseInt(
              opts.waitTimeout ?? opts.timeout ?? "900",
              10,
            );
            run = await waitForComputerRun(runId, waitTimeout);
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(run, null, 2));
            return;
          }

          printBanner({ subtitle: "Computer run" });
          console.log(
            kvPanel([
              { label: "run", value: chalk.bold(String(run["id"] ?? "—")) },
              { label: "computer", value: chalk.dim(id) },
              { label: "runner", value: String(run["runner"] ?? runner) },
              { label: "status", value: colorStatus(String(run["status"] ?? "")) },
              { label: "exit", value: String(run["exit_code"] ?? "—") },
            ]),
          );
          const output = String(run["output"] ?? "").trim();
          const stderr = String(run["stderr"] ?? "").trim();
          if (output) console.log(`\n${output}`);
          if (stderr) console.error(`\n${chalk.red(stderr)}`);
          console.log();
        }),
    );

  // Workspace-aware create (skipped in resourceCommands via skipCommands).
  addDataOption(
    computers!
      .command("create")
      .description("Create a persistent cloud computer with a desktop")
      .option("--name <name>", "Name your computer")
      .option("--size <size>", "Size: small, medium, or large", "small")
      .option("--region <region>", "Location: us-mia, us-nyc, or us-la", "us-mia")
      .option(
        "--workspace <workspace-id>",
        "Workspace to assign the computer to",
      )
      .option(
        "--external-workspace <id>",
        "Your internal workspace ID (attribution)",
      )
      .option(
        "--external-project <id>",
        "Your internal project ID (attribution)",
      )
      .option(
        "--agent-profile <profile-id>",
        "Agent runtime profile to mount into the computer",
      )
      .option(
        "--skip-agent-profile",
        "Do not apply the default agent runtime profile",
      ),
  )
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa computers create --name boris
  miosa computers create --name boris --size medium
  miosa computers create --name boris --region us-nyc

Run without flags for guided setup:
  miosa computers create

Defaults:
  size=small, region=us-mia, desktop included
`,
    )
    .action(
      (
        opts: DataOptions & {
          name?: string;
          size?: string;
          region?: string;
          workspace?: string;
          externalWorkspace?: string;
          externalProject?: string;
          agentProfile?: string;
          skipAgentProfile?: boolean;
        },
      ) =>
        runAction(async () => {
          const base: Record<string, unknown> =
            parseData(opts.data, opts.input, opts.file) ?? {};
          const hasStructuredInput = Boolean(opts.data || opts.input || opts.file);

          if (!opts.name && base["name"] == null && !hasStructuredInput) {
            if (!process.stdin.isTTY || isJsonMode(opts)) {
              throw new UserError(
                "A computer name is required in non-interactive mode.",
                "Try `miosa computers create --name boris`.",
              );
            }
            const answers = await promptForComputerDetails();
            opts.name = answers.name;
            opts.size = answers.size;
            opts.region = answers.region;
          }

          if (opts.name) base["name"] = opts.name;
          if (base["template_type"] == null)
            base["template_type"] = "miosa-desktop";
          if (base["size"] == null) base["size"] = opts.size ?? "small";
          if (base["region"] == null) base["region"] = opts.region ?? "us-mia";
          if (opts.workspace) base["workspace_id"] = opts.workspace;
          if (opts.externalWorkspace)
            base["external_workspace_id"] = opts.externalWorkspace;
          if (opts.externalProject)
            base["external_project_id"] = opts.externalProject;
          if (opts.agentProfile)
            base["agent_runtime_profile_id"] = opts.agentProfile;
          if (opts.skipAgentProfile)
            base["skip_agent_runtime_profile"] = true;

          const createStart = Date.now();
          const result = await client().apiPost<unknown>(
            apiPath("/computers"),
            base,
          );
          const value =
            result !== null &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            "data" in (result as Record<string, unknown>)
              ? (result as Record<string, unknown>)["data"]
              : result;

          if (isJsonMode(opts)) {
            printValue(value, opts);
            return;
          }

          const c =
            value !== null && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : ({} as Record<string, unknown>);
          const newId = String(c["id"] ?? "—");

          printBanner({ subtitle: "Create computer" });
          console.log(
            kvPanel([
              { icon: icon.ok, label: "id", value: chalk.dim(newId) },
              {
                label: "name",
                value: chalk.bold(String(c["name"] ?? base["name"] ?? "—")),
              },
              {
                label: "status",
                value: colorStatus(String(c["status"] ?? "provisioning")),
              },
              {
                label: "type",
                value: "Desktop computer",
              },
              {
                label: "size",
                value: String(c["size"] ?? base["size"] ?? chalk.dim("—")),
              },
              {
                label: "location",
                value: String(c["region"] ?? base["region"] ?? chalk.dim("—")),
              },
            ]),
          );
          const viewerPassword = String(c["viewer_password"] ?? "");
          if (viewerPassword) {
            console.log();
            console.log(
              kvPanel([
                {
                  icon: icon.warn,
                  label: "viewer password",
                  value: chalk.bold(viewerPassword),
                },
              ]),
            );
            console.log();
            console.log(
              `  ${chalk.yellow("Save this password now.")} ${chalk.dim(
                "It is shown once and is only needed for direct or external viewer access.",
              )}`,
            );
            console.log(
              `  ${chalk.dim(
                `Signed-in access with \`miosa computers open ${String(c["name"] ?? newId)}\` does not require it.`,
              )}`,
            );
          }
          console.log();
          console.log(
            hintBlock("Next", [
              `miosa computers open ${String(c["name"] ?? newId)}`,
              `miosa exec ${String(c["name"] ?? newId)} "uname -a"`,
              `miosa computers show ${newId}`,
            ]),
          );
          printElapsed(formatDuration(Date.now() - createStart));
        }),
    );

  const createCommand = computers!.commands.find(
    (command) => command.name() === "create",
  );
  const advancedCreateFlags = new Set([
    "--external-workspace",
    "--external-project",
    "--agent-profile",
    "--skip-agent-profile",
    "--data",
    "--input",
    "--file",
  ]);
  for (const option of createCommand?.options ?? []) {
    if (option.long && advancedCreateFlags.has(option.long)) option.hideHelp();
  }

  computers!
    .command("exec <computer> <command...>")
    .description("Run a command on a computer by name or ID")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa computers exec boris pwd
  miosa computers exec boris "uname -a"
`,
    )
    .action((computerArg: string, command: string[], opts: JsonOptions) =>
      runAction(async () => {
        const selected = await resolveComputerForDesktop(computerArg);
        const computer = await waitUntilDesktopReady(selected);
        const id = toComputerId(String(computer["id"]));
        const response = await new MiosaClient(loadConfig()).computerExec(
          id,
          command.join(" "),
        );
        let exitCode = 0;

        for await (const event of parseSse(response.body)) {
          if (isJsonMode(opts)) {
            console.log(JSON.stringify(event));
            continue;
          }
          if (event.type === "stdout") process.stdout.write(event.data);
          if (event.type === "stderr") process.stderr.write(event.data);
          if (event.type === "error") {
            console.error(chalk.red(event.message));
            exitCode = 1;
          }
          if (event.type === "exit") exitCode = event.exit_code;
        }
        process.exitCode = exitCode;
      }),
    );

  computers!
    .command("logs <computer-id>")
    .description("Show Computer logs")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/computers/${enc(id)}/logs`, opts)),
    );

  computers!
    .command("download <computer-id> <remote-path>")
    .description("Download a file from a Computer to a local path or stdout")
    .option("--output <file>", "Write to this local file instead of stdout")
    .option("--json", "Output as JSON metadata")
    .action(
      (
        id: string,
        remotePath: string,
        opts: { output?: string } & JsonOptions,
      ) =>
        runAction(async () => {
          const query = new URLSearchParams({ path: remotePath });
          const bytes = await client().apiGetBinary(
            apiPath(`/computers/${enc(id)}/files/download?${query.toString()}`),
          );

          if (opts.output) {
            fs.writeFileSync(opts.output, bytes);
            if (isJsonMode(opts)) {
              console.log(
                JSON.stringify(
                  {
                    computer_id: id,
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
            console.log(chalk.green(`Downloaded ${remotePath} → ${opts.output}`));
            return;
          }

          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                {
                  computer_id: id,
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
        }),
    );

  computers!
    .command("export <computer-id> <remote-path>")
    .description("Export a file from a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, remotePath: string, opts: JsonOptions) =>
      runAction(() =>
        postAndPrint(
          `/computers/${enc(id)}/files/export`,
          opts,
          { path: remotePath },
        ),
      ),
    );

  computers!
    .command("delete-checkpoint <computer-id> <checkpoint-id>")
    .alias("delete-snapshot")
    .description("Delete a Computer checkpoint")
    .option("--json", "Output as JSON")
    .action((id: string, sid: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/computers/${enc(id)}/snapshots/${enc(sid)}`, opts),
      ),
    );

  computers!
    .command("open [computer]")
    .alias("desktop")
    .description("Open a running computer's desktop in your browser")
    .option("--print-url", "Print the desktop URL instead of opening it")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa computers open
  miosa computers open boris

When no computer is given, MIOSA shows a picker of running desktops.
`,
    )
    .action(
      (
        computer: string | undefined,
        opts: { printUrl?: boolean; json?: boolean },
      ) => runAction(() => openComputerDesktop(computer, opts)),
    );

  computers!
    .command("vnc <computer-id>")
    .description("Open a desktop by exact computer ID (advanced)")
    .option("--print-url", "Print the URL instead of opening a browser")
    .option("--json", "Output as JSON")
    .action(
      (id: string, opts: { printUrl?: boolean; json?: boolean }) =>
        runAction(() => openComputerDesktop(id, opts)),
    );
}
