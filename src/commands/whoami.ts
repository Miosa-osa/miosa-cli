import type { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  loadAuthCache,
  saveAuthCache,
  redactKey,
} from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, printJson } from "./util.js";

export function register(program: Command): void {
  program
    .command("whoami")
    .description("Show current auth state (instant from cache)")
    .option("--json", "Output as JSON")
    .option("--refresh", "Force a network refresh of the cached identity")
    .action(async (opts: { json?: boolean; refresh?: boolean }) => {
      const config = loadConfig();

      if (!config.api_key) {
        if (opts.json) {
          printJson({ authenticated: false });
          return;
        }
        console.log(chalk.yellow("Not logged in. Run: miosa login"));
        process.exit(1);
      }

      // Fast path: serve from cache unless --refresh requested
      const cached = opts.refresh ? null : loadAuthCache();

      if (cached) {
        if (opts.json) {
          printJson({
            authenticated: true,
            name: cached.name,
            slug: cached.slug,
            plan: cached.plan,
            credit_balance: cached.credit_balance,
            region: cached.region ?? config.region ?? "auto",
            api_key_prefix: redactKey(config.api_key),
            cached_at: cached.cached_at,
          });
          return;
        }

        const region = cached.region ?? config.region ?? "auto";
        console.log();
        console.log(
          `  ${chalk.bold(cached.name)}` + chalk.dim(` (${cached.plan} plan)`),
        );
        console.log(`  Tenant:   ${cached.slug}`);
        console.log(`  API Key:  ${redactKey(config.api_key)}`);
        console.log(`  Region:   ${region}`);
        console.log();
        return;
      }

      // Slow path: fetch from API, then cache the result
      try {
        const client = new MiosaClient(config);
        const tenant = await client.getTenant();

        saveAuthCache({
          email: null,
          name: tenant.name,
          slug: tenant.slug,
          plan: tenant.plan,
          credit_balance: tenant.credit_balance,
          region: config.region,
          cached_at: new Date().toISOString(),
        });

        if (opts.json) {
          printJson({
            authenticated: true,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            credit_balance: tenant.credit_balance,
            region: config.region ?? "auto",
            api_key_prefix: redactKey(config.api_key),
          });
          return;
        }

        const region = config.region ?? "auto";
        console.log();
        console.log(
          `  ${chalk.bold(tenant.name)}` + chalk.dim(` (${tenant.plan} plan)`),
        );
        console.log(`  Tenant:   ${tenant.slug}`);
        console.log(`  API Key:  ${redactKey(config.api_key)}`);
        console.log(`  Region:   ${region}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}
