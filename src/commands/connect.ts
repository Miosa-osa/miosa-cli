import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

const PLATFORMS = [
  "macos",
  "linux",
  "ubuntu",
  "debian",
  "fedora",
  "other",
];

type ConnectOptions = {
  platform?: string;
  wait: boolean;
  waitTimeout: number;
  json?: boolean;
  showInstallCommand?: boolean;
};

export function register(
  program: Command,
  options: {
    command?: string;
    description?: string;
  } = {},
): void {
  program
    .command(options.command ?? "connect [name]")
    .description(
      options.description ??
        "Onboarding wizard: register an OpenComputers host and get its install command",
    )
    .option("--platform <platform>", "Target platform: macos, linux, ubuntu, debian, fedora, or other")
    .option("--no-wait", "Return after creating the host instead of waiting for it to connect")
    .option("--wait-timeout <seconds>", "Maximum connection wait time", "300")
    .option("--show-install-command", "Include the secret-bearing install command in JSON output")
    .option("--json", "Output structured JSON without secrets by default")
    .action(async (nameArg: string | undefined, opts: ConnectOptions) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const { default: inquirer } = await import("inquirer");

        let name = nameArg;
        let platform = opts.platform;

        if (platform && !PLATFORMS.includes(platform)) {
          throw new Error(
            `Unsupported platform: ${platform}. Choose one of: ${PLATFORMS.join(", ")}.`,
          );
        }

        if (process.stdin.isTTY) {
          const answers = await inquirer.prompt<{
            name: string;
            platform: string;
          }>([
            {
              type: "input",
              name: "name",
              message: "Host name (e.g. my-mac, work-laptop):",
              default: nameArg,
              validate: (v: string) =>
                v.trim().length > 0 ? true : "Name is required",
              when: !nameArg,
            },
            {
              type: "list",
              name: "platform",
              message: "Platform:",
              choices: PLATFORMS,
            },
          ]);
          name = name ?? answers.name;
          platform = platform ?? answers.platform;
        } else {
          if (!name) {
            throw new Error("Provide a name: miosa opencomputers connect <name>.");
          }

          if (!platform) {
            throw new Error(
              "Provide --platform when running non-interactively, for example: --platform linux.",
            );
          }
        }

        const waitTimeoutMs = Number(opts.waitTimeout) * 1_000;
        if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
          throw new Error("--wait-timeout must be a positive number of seconds.");
        }

        const spinner = spin(`Registering host "${name}"...`);
        const host = await client.createHost({
          name: name!,
          platform,
        });
        spinner.succeed(`Host registered (id: ${host.id.slice(0, 8)})`);

        if (opts.json) {
          const output = {
            host: {
              id: host.id,
              name: host.name,
              state: host.state,
              platform: host.platform,
            },
            next_step: "Run the install command on the target machine, then use miosa opencomputers list.",
            ...(opts.showInstallCommand
              ? { install_command: host.install_command }
              : {}),
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        if (host.install_command) {
          console.log();
          console.log(chalk.bold("Run this on your machine to connect:"));
          console.log();
          console.log(`  ${chalk.cyan(host.install_command)}`);
          console.log();
        }

        if (!opts.wait) {
          console.log(chalk.dim("Host created. Check its connection with: miosa opencomputers list"));
          return;
        }

        // Poll until online. The CLI never installs the agent itself because the
        // target machine may be different from the one running this command.
        const pollSpinner = spin("Waiting for host to come online...");
        let attempts = 0;
        const maxAttempts = Math.ceil(waitTimeoutMs / 5_000);

        const poll = async (): Promise<void> => {
          while (attempts < maxAttempts) {
            await sleep(5_000);
            attempts++;
            const updated = await client.getHost(host.id);
            if (updated.state === "online") {
              pollSpinner.succeed(
                chalk.green(`Host "${name}" is online! Try: miosa ssh ${name}`),
              );
              return;
            }
            pollSpinner.text = `Waiting for host to come online... (${attempts * 5}s)`;
          }
          pollSpinner.warn(
            `Timed out waiting. Check the host with: miosa opencomputers list`,
          );
        };

        await poll();
      } catch (err) {
        handleError(err);
      }
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
