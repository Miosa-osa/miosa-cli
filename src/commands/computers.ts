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
  postAndPrint,
  printValue,
  resourceCommands,
  runAction,
  unwrap,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { isJsonMode } from "../cli-env.js";
import { loadConfig } from "../config.js";
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
            hintBlock("Try", ["miosa computers create --name <name>"]),
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
            header: "TEMPLATE",
            key: (r) =>
              String(r["template_type"] ?? r["template"] ?? chalk.dim("—")),
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
              label: "template",
              value: String(
                c["template_type"] ?? c["template"] ?? chalk.dim("—"),
              ),
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
            `miosa exec ${id} ...`,
            `miosa watch ${id}`,
            `miosa computers action ${id} stop`,
          ]),
        );
        console.log();
      }),
    );

  // Workspace-aware create (skipped in resourceCommands via skipCommands).
  addDataOption(
    computers!
      .command("create")
      .description("Create a computer")
      .option("--name <name>", "Computer name")
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
    .action(
      (
        opts: DataOptions & {
          name?: string;
          workspace?: string;
          externalWorkspace?: string;
          externalProject?: string;
          agentProfile?: string;
          skipAgentProfile?: boolean;
        },
      ) =>
        runAction(async () => {
          // Merge --name / --workspace flags into the body so callers don't
          // have to pass a full --data JSON blob for common use-cases.
          const base: Record<string, unknown> = opts.data
            ? JSON.parse(opts.data)
            : {};
          if (opts.name) base["name"] = opts.name;
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
              { label: "status", value: colorStatus("provisioning") },
              {
                label: "template",
                value: String(
                  c["template_type"] ??
                    c["template"] ??
                    base["template_type"] ??
                    chalk.dim("—"),
                ),
              },
              {
                label: "size",
                value: String(c["size"] ?? base["size"] ?? chalk.dim("—")),
              },
            ]),
          );
          console.log();
          console.log(
            hintBlock("Next", [
              `miosa computers show ${newId}  # poll until status=running`,
              `miosa exec ${newId} ...`,
            ]),
          );
          printElapsed(formatDuration(Date.now() - createStart));
        }),
    );

  addDataOption(
    computers!
      .command("exec <computer-id>")
      .description("Run a command on a Computer via the raw exec API"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => postAndPrint(`/computers/${enc(id)}/exec`, opts, {})),
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

  const connectors = computers!
    .command("connectors")
    .description("Manage provider connectors bound to a Computer");

  connectors
    .command("list <computer-id>")
    .description("List provider connectors bound to a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/computers/${enc(id)}/connectors`, opts)),
    );

  connectors
    .command("attach <computer-id> <connector>")
    .description("Attach a provider connector to a Computer as a brokered env var")
    .requiredOption("--env <name>", "Environment variable name to expose")
    .option("--mode <mode>", "brokered-env or plain-env", "brokered-env")
    .option("--project <id>", "Project ID for attribution")
    .option("--environment <name>", "Environment name", "development")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        connector: string,
        opts: JsonOptions & {
          env: string;
          mode?: string;
          project?: string;
          environment?: string;
        },
      ) =>
        runAction(() =>
          postAndPrint(
            `/computers/${enc(id)}/connectors`,
            opts,
            {
              connector,
              env_name: opts.env,
              mode: opts.mode?.replaceAll("-", "_"),
              project_id: opts.project,
              environment: opts.environment,
            },
          ),
        ),
    );

  connectors
    .command("detach <computer-id> <binding>")
    .alias("rm")
    .description("Detach a provider connector binding from a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, binding: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/computers/${enc(id)}/connectors/${enc(binding)}`, opts),
      ),
    );

  connectors
    .command("sync <computer-id>")
    .description("Show materialized connector env vars for a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => postAndPrint(`/computers/${enc(id)}/connectors/sync`, opts, {})),
    );

  connectors
    .command("preflight <computer-id>")
    .description("Verify a required provider connector is bound before agent work")
    .option("--connector <uid>", "Connector UID or binding id")
    .option("--provider <provider>", "Provider name for diagnostics")
    .option("--json", "Output as JSON")
    .action(
      (
        id: string,
        opts: JsonOptions & { connector?: string; provider?: string },
      ) =>
        runAction(() =>
          postAndPrint(
            `/computers/${enc(id)}/connectors/preflight`,
            opts,
            {
              connector: opts.connector,
              provider: opts.provider,
            },
          ),
        ),
    );

  computers!
    .command("vnc <computer-id>")
    .description("Open the VNC viewer for a Computer in your browser")
    .option("--print-url", "Print the URL instead of opening a browser")
    .option("--json", "Output as JSON")
    .action(
      async (id: string, opts: { printUrl?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const baseUrl = (config.endpoint || "https://api.miosa.ai").replace(
          /\/$/,
          "",
        );
        const url = `${baseUrl}/api/v1/computers/${enc(id)}/desktop/vnc`;

        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ url }, null, 2));
          return;
        }
        if (opts.printUrl) {
          console.log(url);
          return;
        }
        openUrl(url);
        console.log(`Opening VNC viewer for ${id}…`);
      },
    );
}
