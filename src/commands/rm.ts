import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("rm <host-path>")
    .description("Remove a file or directory on a host (host:/path syntax)")
    .option("-r, --recursive", "Remove directory recursively")
    .option("-f, --force", "Skip confirmation prompt")
    .action(
      async (
        hostPath: string,
        opts: { recursive?: boolean; force?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const { host: hostName, path: remotePath } = parseHostPath(hostPath);
          const host = await client.getHost(hostName);

          if (!opts.force && process.stdin.isTTY) {
            const { default: inquirer } = await import("inquirer");
            const { confirmed } = await inquirer.prompt<{
              confirmed: boolean;
            }>([
              {
                type: "confirm",
                name: "confirmed",
                message: `Remove ${hostName}:${remotePath}${opts.recursive ? " (recursive)" : ""}?`,
                default: false,
              },
            ]);
            if (!confirmed) {
              console.log(chalk.dim("Cancelled."));
              return;
            }
          }

          const spinner = spin(`Removing ${remotePath} on ${host.name}...`);
          await client.deleteFs(host.id, remotePath, opts.recursive ?? false);
          spinner.succeed(chalk.green(`Removed ${hostName}:${remotePath}`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}
