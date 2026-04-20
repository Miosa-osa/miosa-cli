import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, redactKey, getConfigPath } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("status")
    .description("Show current auth, endpoint, tenant info, and host count")
    .action(async () => {
      const config = loadConfig();

      console.log();
      console.log(`  ${chalk.bold("Config")}    ${getConfigPath()}`);
      console.log(`  ${chalk.bold("Endpoint")}  ${config.endpoint}`);
      console.log(`  ${chalk.bold("API Key")}   ${redactKey(config.api_key)}`);

      if (!config.api_key) {
        console.log();
        console.log(chalk.yellow("  Not logged in. Run: miosa login"));
        console.log();
        return;
      }

      const spinner = spin("Fetching account info...");
      try {
        const client = new MiosaClient(config);
        const [tenant, hosts] = await Promise.all([
          client.getTenant(),
          client.listHosts(),
        ]);

        spinner.stop();
        console.log();
        console.log(
          `  ${chalk.bold("Tenant")}    ${tenant.name} (${tenant.slug})`,
        );
        console.log(`  ${chalk.bold("Plan")}      ${tenant.plan}`);
        console.log(
          `  ${chalk.bold("Credits")}   ${tenant.credit_balance.toLocaleString()}`,
        );
        console.log(`  ${chalk.bold("Hosts")}     ${hosts.length} registered`);

        const online = hosts.filter((h) => h.state === "online").length;
        if (online > 0) {
          console.log(`             ${chalk.green(online + " online")}`);
        }

        if (config.default_host) {
          console.log(`  ${chalk.bold("Default")}   ${config.default_host}`);
        }
        console.log();
      } catch (err) {
        spinner.fail("Could not fetch account info");
        handleError(err);
      }
    });
}
