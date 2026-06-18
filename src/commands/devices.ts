import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import { isJsonMode } from "../cli-env.js";
import { renderTable } from "../ui/table.js";
import { apiPath, client, unwrap } from "./enterprise-util.js";
import { handleError } from "./util.js";

type DeviceKind = "sandbox_worker" | "computer";
type DeviceFilter = "all" | DeviceKind;
type ApiRecord = Record<string, unknown>;

type DeviceCatalogEntry = {
  kind: string;
  label: string;
  purpose: string;
  lifecycle: string;
  persistence: string;
  primary_commands: string[];
  use_when: string[];
  avoid_when: string[];
};

type DeviceRecord = {
  id: string;
  kind: DeviceKind;
  source: string;
  name?: string;
  state?: string;
  ready?: boolean;
  persistent?: boolean;
  always_on?: boolean;
  template?: string;
  preview_url?: string;
  timeout_remaining_ms?: number;
  region?: string;
};

type DeviceCommandOptions = {
  json?: boolean;
};

type DeviceExecOptions = DeviceCommandOptions & {
  command?: string;
  timeoutMs?: string;
  cwd?: string;
  env?: string[];
};

type DeviceFilesListOptions = DeviceCommandOptions & {
  path?: string;
};

type DeviceFilesReadOptions = DeviceCommandOptions & {
  path: string;
  output?: string;
  decode?: boolean;
};

type DeviceFilesWriteOptions = DeviceCommandOptions & {
  path: string;
  content?: string;
  contentBase64?: string;
  file?: string;
};

type DeviceExposeOptions = DeviceCommandOptions & {
  port: string;
};

type DeviceDoctorOptions = DeviceCommandOptions & {
  port?: string;
};

type DeviceExtendOptions = DeviceCommandOptions & {
  timeoutSec: string;
};

type DeviceBootstrapOptions = DeviceCommandOptions & {
  runtime: string;
  cwd?: string;
  connector?: string[];
  env?: string[];
  mcp?: string[];
  installCommand?: string;
  skipProbe?: boolean;
};

const RUNTIME_BINARIES: Record<string, string[]> = {
  "claude-code": ["claude-code", "claude"],
  claude: ["claude"],
  codex: ["codex"],
  hermes: ["hermes"],
  osa: ["osa"],
  pi: ["pi"],
  custom: [],
};

const DEVICE_CATALOG: DeviceCatalogEntry[] = [
  {
    kind: "sandbox_worker",
    label: "Sandbox Worker",
    purpose:
      "Isolated Linux workspace for agents to create files, run code, preview apps, snapshot, fork, and publish.",
    lifecycle:
      "Persistent by default. Stop snapshots state; resume/fork continues from saved filesystem when backend snapshots are available.",
    persistence:
      "Use --timeout 1h or sandbox extend during active work. Use snapshot/checkpoint/fork for durable recovery points.",
    primary_commands: [
      "miosa sandbox create --template nextjs --timeout 1h --wait --json",
      "miosa sandbox prompt <id> --provider codex --json -- <task>",
      "miosa sandbox exec <id> -- sh -lc '<command>'",
      "miosa sandbox write-file <id> /workspace/file ./file --json",
      "miosa sandbox publish <id> --wait --json",
    ],
    use_when: [
      "Coding agents should build inside the remote workspace.",
      "You need filesystem, command execution, package installs, preview ports, artifacts, or app publish.",
      "You want Polsia/Nebula-style virtual device behavior without a GUI desktop.",
    ],
    avoid_when: [
      "The task requires a full desktop browser session with VNC/CUA.",
      "You need a long-lived production app; publish it after preview is ready.",
    ],
  },
  {
    kind: "computer",
    label: "Computer",
    purpose:
      "Durable VM/desktop device for browser automation, CUA sessions, SSH, tunnels, and persistent agent control.",
    lifecycle:
      "Managed as a Computer. It is the correct target for GUI/browser-heavy work and remote operator sessions.",
    persistence:
      "Use computer checkpoints, volumes, tunnels, and agent sessions for long-lived desktop workflows.",
    primary_commands: [
      "miosa computers list --json",
      "miosa up --computer --json",
      "miosa agent <computer-id> '<task>'",
      "miosa desktop open <computer-id>",
      "miosa tunnel open <computer-id> --port 3000",
    ],
    use_when: [
      "The agent must use Chromium or a full desktop.",
      "The workflow needs login to dashboards, form filling, screenshots, or CUA-style control.",
      "A human and agent need to share the same persistent machine state.",
    ],
    avoid_when: [
      "Simple code generation/build/test work fits a cheaper sandbox worker.",
      "The output is a production deployment; use Docker Deploy or standard deploy after build.",
    ],
  },
  {
    kind: "local_device",
    label: "Local Device",
    purpose:
      "A developer-owned machine connected through MIOSA CLI/MCP for local files, diagnostics, and private tools.",
    lifecycle:
      "Not hosted by MIOSA. The user owns uptime, filesystem state, and local credentials.",
    persistence:
      "State is whatever exists on the developer machine; do not assume cloud resume semantics.",
    primary_commands: [
      "miosa mcp install --client claude --scope user",
      "miosa doctor --json",
      "miosa status --json",
    ],
    use_when: [
      "The user wants to connect an existing local coding environment.",
      "The agent needs local repository context before creating a cloud device.",
    ],
    avoid_when: [
      "Customer code must stay isolated in MIOSA-hosted infrastructure.",
      "The workflow needs reproducible shared cloud state.",
    ],
  },
  {
    kind: "docker_deploy_host",
    label: "Docker Deploy Host",
    purpose:
      "Workspace appliance VM that runs Docker containers for durable apps published from sandboxes.",
    lifecycle:
      "Always-on deployment capacity. Apps are versioned releases, not interactive coding workspaces.",
    persistence:
      "App releases and routing are durable; use sandbox workers for edits, then publish to the host.",
    primary_commands: [
      "miosa docker-deploy hosts list --json",
      "miosa sandbox publish <id> --docker-deploy --wait --json",
      "miosa deploy --docker-deploy --wait --json",
    ],
    use_when: [
      "You need many small apps, APIs, funnels, or client sites in one workspace appliance.",
      "You want stable public URLs backed by Docker containers.",
    ],
    avoid_when: [
      "Interactive agent work is still happening; finish in a sandbox first.",
      "The app needs the standard MIOSA Deploy runtime instead of Docker Deploy.",
    ],
  },
];

const ROUTING = {
  build_code:
    "Use sandbox_worker. Run the coding agent inside it with sandbox prompt/exec and publish after HTTP 200.",
  browser_automation:
    "Use computer. It has the desktop/browser/CUA surface needed for dashboards, clicks, and visual inspection.",
  durable_app:
    "Use docker_deploy_host after the app is ready. Publish from the sandbox into a versioned deployment.",
  local_private_context:
    "Use local_device only for local discovery or user-owned files, then move execution into a sandbox/computer.",
  massive_parallel_agents:
    "Use one sandbox_worker per isolated code/task shard, computers only where GUI/browser state is required, and Docker Deploy for durable outputs.",
};

export function register(program: Command): void {
  const devices = program
    .command("devices")
    .alias("device")
    .description(
      "Inspect MIOSA device types: sandboxes, computers, local devices, and Docker Deploy hosts",
    );

  devices
    .command("catalog")
    .description("Print the MIOSA device catalog and routing guidance")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) =>
      runDeviceAction(async () => {
        const output = { devices: DEVICE_CATALOG, routing: ROUTING };
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(chalk.bold("MIOSA devices"));
        console.log();
        renderTable(DEVICE_CATALOG, [
          { header: "KIND", key: (row) => row.kind },
          { header: "LABEL", key: (row) => row.label },
          { header: "PURPOSE", key: (row) => row.purpose, width: 72 },
        ]);
        console.log();
        console.log(chalk.bold("Routing"));
        for (const [job, guidance] of Object.entries(ROUTING)) {
          console.log(`${chalk.cyan(job.padEnd(24))} ${guidance}`);
        }
      }),
    );

  devices
    .command("list")
    .description("List active hosted devices from sandboxes and computers")
    .option("--type <kind>", "Filter: all, sandbox_worker, sandbox, computer", "all")
    .option("--json", "Output as JSON")
    .action((opts: { type?: string; json?: boolean }) =>
      runDeviceAction(async () => {
        const filter = normalizeKindFilter(opts.type ?? "all");
        const records = unwrapList(
          await client().apiGet(
            apiPath(`/devices${queryString({ kind: apiKindFilter(filter) })}`),
          ),
          ["devices"],
        ).map(normalizeDevice);
        const output = { devices: records };
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        if (records.length === 0) {
          console.log(chalk.dim("No hosted devices found."));
        } else {
          renderTable(records, [
            { header: "ID", key: (row) => row.id, width: 12 },
            { header: "KIND", key: (row) => row.kind },
            { header: "NAME", key: (row) => row.name ?? "-" },
            { header: "STATE", key: (row) => row.state ?? "-" },
            {
              header: "READY",
              key: (row) =>
                row.ready == null ? "-" : row.ready ? "yes" : "no",
            },
            {
              header: "PERSISTENT",
              key: (row) =>
                row.persistent == null
                  ? "-"
                  : row.persistent
                    ? "yes"
                    : "no",
            },
            { header: "PREVIEW", key: (row) => row.preview_url ?? "-" },
          ]);
        }

      }),
    );

  devices
    .command("show <id>")
    .description("Show one hosted device")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(await client().apiGet(apiPath(`/devices/${encodeURIComponent(id)}`)));
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("capabilities <id>")
    .description("Show what a device supports")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiGet(apiPath(`/devices/${encodeURIComponent(id)}/capabilities`)),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("exec <id>")
    .description("Run a command inside a sandbox/computer device")
    .requiredOption("-c, --command <command>", "Command to run")
    .option("--timeout-ms <ms>", "Command timeout in milliseconds")
    .option("--cwd <path>", "Working directory")
    .option("--env <KEY=VALUE>", "Environment variable. Repeatable.", collect, [])
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceExecOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/exec`), {
            command: opts.command,
            timeout_ms: opts.timeoutMs ? Number.parseInt(opts.timeoutMs, 10) : undefined,
            cwd: opts.cwd,
            env: parseEnv(opts.env ?? []),
          }),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("doctor <id>")
    .description("Run an agent-friendly health probe against a device")
    .option("--port <port>", "Also verify a port can be exposed")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceDoctorOptions) =>
      runDeviceAction(async () => {
        const encoded = encodeURIComponent(id);
        const checks: Array<{
          name: string;
          ok: boolean;
          detail?: unknown;
          error?: string;
        }> = [];

        await recordCheck(checks, "capabilities", async () =>
          unwrap(await client().apiGet(apiPath(`/devices/${encoded}/capabilities`))),
        );
        await recordCheck(checks, "exec", async () =>
          unwrap(
            await client().apiPost(apiPath(`/devices/${encoded}/exec`), {
              command: "pwd && uname -s",
              timeout_ms: 30_000,
            }),
          ),
        );
        await recordCheck(checks, "files", async () =>
          unwrapList(
            await client().apiGet(
              apiPath(`/devices/${encoded}/files${queryString({ path: "/workspace" })}`),
            ),
            ["entries", "files"],
          ),
        );

        if (opts.port) {
          await recordCheck(checks, "expose", async () =>
            unwrap(
              await client().apiPost(apiPath(`/devices/${encoded}/expose`), {
                port: Number.parseInt(opts.port ?? "", 10),
              }),
            ),
          );
        }

        const output = {
          device_id: id,
          ok: checks.every((check) => check.ok),
          checks,
        };

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(chalk.bold(`Device doctor ${id}`));
        for (const check of checks) {
          const status = check.ok ? chalk.green("ok") : chalk.red("fail");
          console.log(`${status.padEnd(12)} ${check.name}`);
          if (!check.ok && check.error) console.log(chalk.red(`  ${check.error}`));
        }
      }),
    );

  devices
    .command("bootstrap <id>")
    .description("Prepare a device for an agent runtime and write a MIOSA runtime manifest")
    .requiredOption("--runtime <runtime>", "osa, claude-code, claude, codex, hermes, pi, or custom")
    .option("--cwd <path>", "Runtime working directory", "/workspace")
    .option("--connector <uid>", "Required connector UID. Repeatable.", collect, [])
    .option("--env <KEY=VALUE>", "Runtime env default. Repeatable.", collect, [])
    .option("--mcp <name=url>", "Runtime MCP server hint. Repeatable.", collect, [])
    .option("--install-command <command>", "Optional command to install/bootstrap the runtime")
    .option("--skip-probe", "Do not run a binary/runtime probe after writing manifest")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceBootstrapOptions) =>
      runDeviceAction(async () => {
        const runtime = normalizeRuntime(opts.runtime);
        const cwd = opts.cwd ?? "/workspace";
        const manifestPath = `${cwd.replace(/\/$/, "")}/.miosa/runtime-bootstrap.json`;
        const manifest = {
          version: 1,
          runtime,
          cwd,
          expected_binaries: RUNTIME_BINARIES[runtime] ?? [],
          connectors: opts.connector ?? [],
          env: parseEnv(opts.env ?? []) ?? {},
          mcp: parseMcp(opts.mcp ?? []),
          created_by: "miosa-cli",
        };

        const steps: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }> = [];

        await recordCheck(steps, "write_manifest", async () =>
          unwrap(
            await client().apiPost(
              apiPath(`/devices/${encodeURIComponent(id)}/files/write`),
              {
                path: manifestPath,
                content: `${JSON.stringify(manifest, null, 2)}\n`,
              },
            ),
          ),
        );

        if (opts.installCommand) {
          await recordCheck(steps, "install", async () =>
            unwrap(
              await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/exec`), {
                command: opts.installCommand,
                cwd,
                timeout_ms: 600_000,
              }),
            ),
          );
        }

        if (!opts.skipProbe) {
          await recordCheck(steps, "probe", async () =>
            unwrap(
              await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/exec`), {
                command: runtimeProbeCommand(runtime),
                cwd,
                timeout_ms: 60_000,
              }),
            ),
          );
        }

        const output = {
          device_id: id,
          ok: steps.every((step) => step.ok),
          runtime,
          manifest_path: manifestPath,
          steps,
        };

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        console.log(chalk.bold(`Bootstrapped ${runtime} on ${id}`));
        console.log(`${chalk.bold("manifest")} ${manifestPath}`);
        for (const step of steps) {
          const status = step.ok ? chalk.green("ok") : chalk.red("fail");
          console.log(`${status.padEnd(12)} ${step.name}`);
          if (!step.ok && step.error) console.log(chalk.red(`  ${step.error}`));
        }
      }),
    );

  const files = devices
    .command("files")
    .description("Read, write, and list files inside a device");

  files
    .command("list <id>")
    .description("List files inside a device")
    .option("--path <path>", "Directory path", "/workspace")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceFilesListOptions) =>
      runDeviceAction(async () => {
        const raw = unwrapList(
          await client().apiGet(
            apiPath(
              `/devices/${encodeURIComponent(id)}/files${queryString({ path: opts.path })}`,
            ),
          ),
          ["entries", "files"],
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        renderTable(raw, [
          { header: "PATH", key: (row) => optionalString(row, "path") ?? "" },
          { header: "TYPE", key: (row) => optionalString(row, "type") ?? "-" },
          { header: "SIZE", key: (row) => String(optionalNumber(row, "size") ?? "-") },
        ]);
      }),
    );

  files
    .command("read <id>")
    .description("Read a file from a device")
    .requiredOption("--path <path>", "File path")
    .option("-o, --output <path>", "Write decoded bytes to a local file")
    .option("--decode", "Print decoded text instead of the JSON/base64 envelope")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceFilesReadOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap<ApiRecord>(
          await client().apiGet(
            apiPath(
              `/devices/${encodeURIComponent(id)}/files/read${queryString({ path: opts.path })}`,
            ),
          ),
        );
        if (opts.output) {
          writeFileSync(opts.output, decodeFileContent(raw));
          if (!isJsonMode(opts)) console.log(chalk.green(`Wrote ${opts.output}`));
          else console.log(JSON.stringify({ output: opts.output }, null, 2));
          return;
        }
        if (opts.decode) {
          console.log(decodeFileContent(raw).toString("utf8"));
          return;
        }
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  files
    .command("write <id>")
    .description("Write a file into a device")
    .requiredOption("--path <path>", "Destination file path")
    .option("--content <text>", "Text content to write")
    .option("--content-base64 <base64>", "Base64 content to write")
    .option("--file <path>", "Read local file bytes and upload as base64")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceFilesWriteOptions) =>
      runDeviceAction(async () => {
        const body = writeFileBody(opts);
        const raw = unwrap(
          await client().apiPost(
            apiPath(`/devices/${encodeURIComponent(id)}/files/write`),
            body,
          ),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("expose <id>")
    .description("Expose a device port through MIOSA routing")
    .requiredOption("--port <port>", "Port to expose")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceExposeOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/expose`), {
            port: Number.parseInt(opts.port, 10),
          }),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("browser <id>")
    .description("Return browser/desktop connection details for a computer-backed device")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiGet(apiPath(`/devices/${encodeURIComponent(id)}/browser`)),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("pause <id>")
    .description("Pause a device session when supported")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      postDeviceLifecycle(id, "pause", opts),
    );

  devices
    .command("stop <id>")
    .description("Stop a device session when supported")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      postDeviceLifecycle(id, "stop", opts),
    );

  devices
    .command("resume <id>")
    .description("Resume a device session when supported")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      postDeviceLifecycle(id, "resume", opts),
    );

  devices
    .command("extend <id>")
    .description("Extend a device timeout when supported")
    .requiredOption("--timeout-sec <seconds>", "New timeout in seconds")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceExtendOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/extend`), {
            timeout_sec: Number.parseInt(opts.timeoutSec, 10),
          }),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );

  devices
    .command("destroy <id>")
    .alias("delete")
    .description("Destroy/delete a device when supported")
    .option("--json", "Output as JSON")
    .action((id: string, opts: DeviceCommandOptions) =>
      runDeviceAction(async () => {
        const raw = unwrap(
          await client().apiDelete(apiPath(`/devices/${encodeURIComponent(id)}`)),
        );
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }
        printObject(raw);
      }),
    );
}

function normalizeKindFilter(value: string): DeviceFilter {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "all") return "all";
  if (normalized === "sandbox") return "sandbox_worker";
  if (normalized === "sandbox_worker") return "sandbox_worker";
  if (normalized === "computer") return "computer";
  throw new Error(
    `Unsupported device type "${value}". Use: all, sandbox_worker, sandbox, computer`,
  );
}

function apiKindFilter(filter: DeviceFilter): string | undefined {
  if (filter === "all") return undefined;
  if (filter === "sandbox_worker") return "sandbox";
  return filter;
}

function normalizeDevice(row: ApiRecord): DeviceRecord {
  const kind = optionalString(row, "kind") ?? optionalString(row, "type") ?? "";
  if (kind === "computer") return normalizeComputer(row);
  return normalizeSandbox(row);
}

function normalizeSandbox(row: ApiRecord): DeviceRecord {
  return {
    id: stringField(row, "id"),
    kind: "sandbox_worker",
    source: "sandboxes",
    name: optionalString(row, "name"),
    state: optionalString(row, "state") ?? optionalString(row, "status"),
    ready: optionalBoolean(row, "ready"),
    persistent: optionalBoolean(row, "persistent"),
    always_on: optionalBoolean(row, "always_on"),
    template: optionalString(row, "template_id") ?? optionalString(row, "template"),
    preview_url: optionalString(row, "preview_url"),
    timeout_remaining_ms: optionalNumber(row, "timeout_remaining_ms"),
  };
}

function normalizeComputer(row: ApiRecord): DeviceRecord {
  return {
    id: stringField(row, "id"),
    kind: "computer",
    source: "computers",
    name: optionalString(row, "name"),
    state: optionalString(row, "status") ?? optionalString(row, "state"),
    ready: optionalBoolean(row, "ready"),
    region: optionalString(row, "region"),
    template: optionalString(row, "template_type") ?? optionalString(row, "template"),
  };
}

function unwrapList(payload: unknown, keys: string[]): ApiRecord[] {
  const value = unwrap(payload);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of keys) {
      const nested = value[key];
      if (Array.isArray(nested)) return nested.filter(isRecord);
    }
  }
  return [];
}

function stringField(row: ApiRecord, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : String(value ?? "");
}

function optionalString(row: ApiRecord, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(row: ApiRecord, key: string): boolean | undefined {
  return typeof row[key] === "boolean" ? row[key] : undefined;
}

function optionalNumber(row: ApiRecord, key: string): number | undefined {
  return typeof row[key] === "number" ? row[key] : undefined;
}

function isRecord(value: unknown): value is ApiRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function printObject(value: unknown): void {
  if (!isRecord(value)) {
    console.log(String(value ?? ""));
    return;
  }
  for (const [key, cell] of Object.entries(value)) {
    const printable =
      cell === null || cell === undefined
        ? "-"
        : typeof cell === "object"
          ? JSON.stringify(cell)
          : String(cell);
    console.log(`${chalk.bold(key.padEnd(18))} ${printable}`);
  }
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --env value "${entry}". Use KEY=VALUE.`);
    out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}

function parseMcp(entries: string[]): Array<{ name: string; url: string }> {
  return entries.map((entry) => {
    const index = entry.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --mcp value "${entry}". Use name=url.`);
    return { name: entry.slice(0, index), url: entry.slice(index + 1) };
  });
}

function normalizeRuntime(value: string): string {
  const runtime = value.trim().toLowerCase();
  if (!(runtime in RUNTIME_BINARIES)) {
    throw new Error(
      `Unsupported runtime "${value}". Use: osa, claude-code, claude, codex, hermes, pi, custom`,
    );
  }
  return runtime;
}

function runtimeProbeCommand(runtime: string): string {
  const binaries = RUNTIME_BINARIES[runtime] ?? [];
  if (binaries.length === 0) {
    return "printf 'custom runtime manifest written\\n'";
  }
  const checks = binaries
    .map((binary) => `command -v ${shellWord(binary)} >/dev/null 2>&1`)
    .join(" || ");
  const display = binaries.join(" or ");
  return `${checks} && printf 'runtime available: ${display}\\n' || { printf 'runtime missing: ${display}\\n' >&2; exit 127; }`;
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function decodeFileContent(row: ApiRecord): Buffer {
  const content = optionalString(row, "content") ?? "";
  const encoding = optionalString(row, "encoding") ?? "base64";
  return encoding === "base64"
    ? Buffer.from(content, "base64")
    : Buffer.from(content, "utf8");
}

function writeFileBody(opts: DeviceFilesWriteOptions): ApiRecord {
  const provided = [opts.content, opts.contentBase64, opts.file].filter(
    (value) => value !== undefined,
  );
  if (provided.length !== 1) {
    throw new Error("Use exactly one of --content, --content-base64, or --file");
  }
  return {
    path: opts.path,
    content: opts.content,
    content_base64:
      opts.contentBase64 ??
      (opts.file ? readFileSync(opts.file).toString("base64") : undefined),
  };
}

async function recordCheck(
  checks: Array<{ name: string; ok: boolean; detail?: unknown; error?: string }>,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    checks.push({ name, ok: true, detail: await fn() });
  } catch (err) {
    checks.push({
      name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function postDeviceLifecycle(
  id: string,
  action: "pause" | "stop" | "resume",
  opts: DeviceCommandOptions,
): Promise<void> {
  return runDeviceAction(async () => {
    const raw = unwrap(
      await client().apiPost(apiPath(`/devices/${encodeURIComponent(id)}/${action}`), {}),
    );
    if (isJsonMode(opts)) {
      console.log(JSON.stringify(raw, null, 2));
      return;
    }
    printObject(raw);
  });
}

async function runDeviceAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    handleError(err);
  }
}
