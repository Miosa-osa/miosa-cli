import type { Command } from "commander";
import chalk from "chalk";
import { configExists, getConfigPath, loadConfig, redactKey } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, printJson } from "./util.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function register(program: Command): void {
  program
    .command("doctor")
    .description("Run CLI, auth, API, and host connectivity diagnostics")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const checks: Check[] = [
          {
            name: "config",
            ok: configExists(),
            detail: configExists() ? getConfigPath() : "No config file yet",
          },
          {
            name: "endpoint",
            ok: /^https?:\/\//.test(config.endpoint),
            detail: config.endpoint,
          },
          {
            name: "api_key",
            ok: Boolean(config.api_key),
            detail: redactKey(config.api_key),
          },
        ];

        if (config.api_key) {
          const client = new MiosaClient(config);
          try {
            const tenant = await client.getTenant();
            checks.push({
              name: "auth",
              ok: true,
              detail: `${tenant.name} (${tenant.slug})`,
            });
          } catch (err) {
            checks.push({
              name: "auth",
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }

          try {
            const hosts = await client.listHosts();
            const online = hosts.filter((h) => h.state === "online").length;
            checks.push({
              name: "hosts",
              ok: true,
              detail: `${hosts.length} registered, ${online} online`,
            });
          } catch (err) {
            checks.push({
              name: "hosts",
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (opts.json) return printJson({ ok: checks.every((c) => c.ok), checks });

        console.log();
        for (const check of checks) {
          const mark = check.ok ? chalk.green("ok") : chalk.red("fail");
          console.log(`  ${mark.padEnd(12)} ${chalk.bold(check.name)}  ${check.detail}`);
        }
        console.log();
        if (checks.some((c) => !c.ok)) process.exit(1);
      } catch (err) {
        handleError(err);
      }
    });
}
