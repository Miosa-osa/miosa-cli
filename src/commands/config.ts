import type { Command } from "commander";
import chalk from "chalk";
import {
  CONFIG_KEY_DESCRIPTIONS,
  CONFIG_KEYS,
  getConfigValue,
  getConfigPath,
  loadConfig,
  setConfigValue,
  type ConfigKey,
} from "../config.js";
import { UserError } from "../errors.js";
import { handleError, printJson } from "./util.js";

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export function register(program: Command): void {
  const cfg = program.command("config").description("Manage CLI configuration");

  // miosa config ls
  cfg
    .command("ls")
    .description("List all config keys and their current values")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const config = loadConfig();

        const rows = CONFIG_KEYS.map((key) => ({
          key,
          value: getConfigValue(key) || chalk.dim("(unset)"),
          description: CONFIG_KEY_DESCRIPTIONS[key],
        }));

        if (opts.json) {
          printJson(
            Object.fromEntries(CONFIG_KEYS.map((k) => [k, getConfigValue(k)])),
          );
          return;
        }

        console.log();
        console.log(chalk.dim(`  Config file: ${getConfigPath()}`));
        console.log();

        const keyWidth = Math.max(...CONFIG_KEYS.map((k) => k.length));

        for (const row of rows) {
          // Mark values that come from environment variables
          let display = row.value;
          if (row.key === "api_url" && process.env["MIOSA_ENDPOINT"]) {
            display += chalk.dim(" (env: MIOSA_ENDPOINT)");
          } else if (row.key === "region" && process.env["MIOSA_REGION"]) {
            display += chalk.dim(" (env: MIOSA_REGION)");
          }
          // Redact the api_key if someone uses `config ls` on a field that exposes it
          console.log(`  ${chalk.bold(row.key.padEnd(keyWidth))}  ${display}`);
        }

        // Show endpoint separately since it maps to api_url
        const apiUrl = config.endpoint;
        console.log();
        console.log(chalk.dim(`  Endpoint: ${apiUrl}`));
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // miosa config get <key>
  cfg
    .command("get <key>")
    .description("Get the value of a config key")
    .action((key: string) => {
      try {
        if (!isConfigKey(key)) {
          throw new UserError(
            `Unknown config key: ${key}`,
            `Valid keys: ${CONFIG_KEYS.join(", ")}`,
          );
        }
        const value = getConfigValue(key);
        if (!value) {
          console.log(chalk.dim("(unset)"));
        } else {
          console.log(value);
        }
      } catch (err) {
        handleError(err);
      }
    });

  // miosa config set <key> <value>
  cfg
    .command("set <key> <value>")
    .description("Set a config key")
    .action((key: string, value: string) => {
      try {
        if (!isConfigKey(key)) {
          throw new UserError(
            `Unknown config key: ${key}`,
            `Valid keys: ${CONFIG_KEYS.join(", ")}`,
          );
        }

        // Validate specific keys
        if (key === "output" && !["text", "json"].includes(value)) {
          throw new UserError(
            `Invalid value for output: ${value}`,
            "Valid values: text, json",
          );
        }

        if (key === "api_url" && !/^https?:\/\//.test(value)) {
          throw new UserError(
            `Invalid api_url: ${value}`,
            "Must start with http:// or https://",
          );
        }

        setConfigValue(key, value);
        console.log(
          `${chalk.dim("Set")} ${chalk.bold(key)} ${chalk.dim("=")} ${value}`,
        );
      } catch (err) {
        handleError(err);
      }
    });

  // miosa config unset <key>
  cfg
    .command("unset <key>")
    .description("Remove a config key (reset to default)")
    .action((key: string) => {
      try {
        if (!isConfigKey(key)) {
          throw new UserError(
            `Unknown config key: ${key}`,
            `Valid keys: ${CONFIG_KEYS.join(", ")}`,
          );
        }
        setConfigValue(key, "");
        console.log(chalk.dim(`Unset ${key}`));
      } catch (err) {
        handleError(err);
      }
    });
}
