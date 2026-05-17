import type { Command } from "commander";
import { clearApiKey, loadConfig } from "../config.js";
import chalk from "chalk";

export function register(program: Command): void {
  program
    .command("logout")
    .description("Remove stored credentials and auth cache")
    .action(() => {
      const config = loadConfig();
      if (!config.api_key) {
        console.log(chalk.dim("Not logged in."));
        return;
      }
      clearApiKey(); // also clears auth cache via clearAuthCache()
      console.log(
        chalk.green("Logged out. Credentials removed from ~/.miosa/"),
      );
    });
}
