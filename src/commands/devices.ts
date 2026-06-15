import type { Command } from "commander";
import chalk from "chalk";
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
        const { devices: records, errors } = await listDevices(filter);
        const output = { devices: records, errors };
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

        if (errors.length > 0) {
          console.log();
          console.log(chalk.yellow("Partial inventory errors:"));
          for (const error of errors) {
            console.log(`- ${error.source}: ${error.message}`);
          }
        }
      }),
    );
}

async function listDevices(
  filter: DeviceFilter,
): Promise<{ devices: DeviceRecord[]; errors: Array<{ source: string; message: string; retryable: boolean }> }> {
  const records: DeviceRecord[] = [];
  const errors: Array<{ source: string; message: string; retryable: boolean }> = [];

  if (filter === "all" || filter === "sandbox_worker") {
    try {
      const sandboxes = unwrapList(
        await client().apiGet(apiPath("/sandboxes")),
        ["sandboxes"],
      );
      records.push(...sandboxes.map(normalizeSandbox));
    } catch (err) {
      errors.push(deviceListError("sandboxes", err));
    }
  }

  if (filter === "all" || filter === "computer") {
    try {
      const computers = unwrapList(
        await client().apiGet(apiPath("/computers")),
        ["computers"],
      );
      records.push(...computers.map(normalizeComputer));
    } catch (err) {
      errors.push(deviceListError("computers", err));
    }
  }

  return { devices: records, errors };
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

function deviceListError(
  source: string,
  err: unknown,
): { source: string; message: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    source,
    message,
    retryable:
      /fetch failed|ECONNRESET|HTTP 502|other side closed|socket hang up|bad gateway/i.test(
        message,
      ),
  };
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

async function runDeviceAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    handleError(err);
  }
}
