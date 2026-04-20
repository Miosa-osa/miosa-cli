import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

const PLATFORMS = [
  "macos",
  "linux",
  "windows",
  "ubuntu",
  "debian",
  "fedora",
  "other",
];

export function register(program: Command): void {
  program
    .command("connect [name]")
    .description(
      "Onboarding wizard: register a new host and get the install command",
    )
    .action(async (nameArg?: string) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const { default: inquirer } = await import("inquirer");

        let name = nameArg;
        let platform: string | undefined;

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
          platform = answers.platform;
        } else {
          if (!name) {
            console.error("Provide a name: miosa connect <name>");
            process.exit(1);
          }
        }

        const spinner = spin(`Registering host "${name}"...`);
        const host = await client.createHost({
          name: name!,
          platform,
        });
        spinner.succeed(`Host registered (id: ${host.id.slice(0, 8)})`);

        if (host.install_command) {
          console.log();
          console.log(chalk.bold("Run this on your machine to connect:"));
          console.log();
          console.log(`  ${chalk.cyan(host.install_command)}`);
          console.log();
        }

        if (host.host_key) {
          console.log(
            chalk.dim(`  Host key: ${host.host_key} (keep this secret)`),
          );
          console.log();
        }

        // Poll until online
        const pollSpinner = spin("Waiting for host to come online...");
        let attempts = 0;
        const maxAttempts = 60; // 5 minutes at 5s intervals

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
            `Timed out waiting. Check the host and retry: miosa host ${name}`,
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
