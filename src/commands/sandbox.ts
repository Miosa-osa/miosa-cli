import type { Command } from "commander";
import { spawn } from "node:child_process";
import {
  addDataOption,
  deleteAndPrint,
  enc,
  getAndPrint,
  postAndPrint,
  resourceCommands,
  runAction,
  type DataOptions,
  type JsonOptions,
} from "./enterprise-util.js";
import { loadConfig } from "../config.js";

const actions = ["start", "stop", "restart"] as const;

export function register(program: Command): void {
  resourceCommands({
    program,
    command: "sandbox",
    description:
      "Manage Sandboxes — lightweight code-only Computers (Firecracker microVMs without a desktop)",
    route: "/sandboxes",
    itemName: "sandbox-id",
    actions,
  });

  // Plural alias so `miosa sandboxes …` also works.
  const sandbox = program.commands.find((cmd) => cmd.name() === "sandbox");
  sandbox!.alias("sandboxes");

  // Run a command inside a Sandbox via the raw exec API.
  addDataOption(
    sandbox!
      .command("exec <sandbox-id>")
      .description("Run a command inside a Sandbox via the raw exec API"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() => postAndPrint(`/sandboxes/${enc(id)}/exec`, opts, {})),
    );

  // Stream a command's output.
  sandbox!
    .command("logs <sandbox-id>")
    .description("Show Sandbox logs")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`/sandboxes/${enc(id)}/logs`, opts)),
    );

  // SSH-style interactive shell. Routes through the platform's terminal/PTY
  // endpoint; opens a browser session with a one-shot ticket.
  sandbox!
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
        console.log(`Opening terminal for sandbox ${id}…`);
      },
    );

  // ls — quick alias to `list` since muscle memory says `ls`.
  sandbox!
    .command("ls")
    .description("Alias for `list`")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint("/sandboxes", opts)),
    );

  // destroy — alias to `delete` for consistency with `apps destroy` etc.
  sandbox!
    .command("destroy <sandbox-id>")
    .alias("rm")
    .description("Destroy a Sandbox (alias for `delete`)")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/sandboxes/${enc(id)}`, opts)),
    );

  // Checkpoint shortcuts.
  addDataOption(
    sandbox!
      .command("checkpoint <sandbox-id>")
      .description("Create a Checkpoint (memory state snapshot) of a Sandbox"),
  )
    .option("--json", "Output as JSON")
    .action((id: string, opts: DataOptions) =>
      runAction(() =>
        postAndPrint(`/sandboxes/${enc(id)}/snapshots`, opts, {}),
      ),
    );

  sandbox!
    .command("delete-checkpoint <sandbox-id> <checkpoint-id>")
    .alias("delete-snapshot")
    .description("Delete a Sandbox Checkpoint")
    .option("--json", "Output as JSON")
    .action((id: string, sid: string, opts: JsonOptions) =>
      runAction(() =>
        deleteAndPrint(`/sandboxes/${enc(id)}/snapshots/${enc(sid)}`, opts),
      ),
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
