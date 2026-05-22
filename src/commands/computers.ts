import type { Command } from "commander";
import { spawn } from "node:child_process";
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
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { loadConfig } from "../config.js";

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

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "computers",
    description:
      "Manage Computers (Firecracker microVMs with optional desktops)",
    route: "/computers",
    itemName: "computer-id",
    actions,
    // Both list and create are registered below with workspace-aware overrides.
    skipCommands: ["list", "create"],
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
        await getAndPrint(path, opts);
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
          printValue(value, opts);
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

        if (opts.json) {
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
