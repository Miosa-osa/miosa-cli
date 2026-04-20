import type { Command } from "commander";
import { clearApiKey, loadConfig } from "../config.js";
import chalk from "chalk";

export function register(program: Command): void {
  program
    .command("logout")
    .description("Remove stored API key")
    .action(() => {
      const config = loadConfig();
      if (!config.api_key) {
        console.log(chalk.dim("Not logged in."));
        return;
      }
      clearApiKey();
      console.log(chalk.green("Logged out. API key removed from config."));
    });
}
