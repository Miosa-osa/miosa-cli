import type { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  loadAuthCache,
  saveAuthCache,
  redactKey,
} from "../config.js";
import { MiosaClient } from "../client.js";
import {
  banner,
  errorEnvelope,
  hintBlock,
  icon,
  kvPanel,
} from "../ui/render.js";
import { printJson } from "./util.js";

export function register(program: Command): void {
  program
    .command("whoami")
    .description("Show current auth state (instant from cache)")
    .option("--json", "Output as JSON")
    .option("--refresh", "Force a network refresh of the cached identity")
    .action(async (opts: { json?: boolean; refresh?: boolean }) => {
      const config = loadConfig();

      // ── Not signed in ────────────────────────────────────────────────
      if (!config.api_key) {
        if (opts.json) {
          printJson({ authenticated: false });
          return;
        }
        console.log();
        console.log(`  ${icon.warn}  ${chalk.bold("Not signed in")}`);
        console.log();
        console.log(hintBlock("Sign in", ["miosa login"]));
        process.exit(1);
      }

      // ── Fast path: serve from cache ─────────────────────────────────
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
        renderIdentity({
          name: cached.name,
          slug: cached.slug,
          plan: cached.plan,
          credit_balance: cached.credit_balance,
          region: cached.region ?? config.region ?? "auto",
          api_key: config.api_key,
          fromCache: true,
        });
        return;
      }

      // ── Slow path: fetch + cache ────────────────────────────────────
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

        renderIdentity({
          name: tenant.name,
          slug: tenant.slug,
          plan: tenant.plan,
          credit_balance: tenant.credit_balance,
          region: config.region ?? "auto",
          api_key: config.api_key,
          fromCache: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log();
        console.log(
          errorEnvelope({
            title: "Could not load identity",
            body: message,
            suggest: [
              "miosa whoami --refresh  # bypass the local cache",
              "miosa login  # re-authenticate if your key was revoked",
            ],
            withDebugHint: true,
          }),
        );
        process.exit(1);
      }
    });
}

interface IdentitySummary {
  name: string;
  slug: string;
  plan?: string | null;
  credit_balance?: number | null;
  region: string;
  api_key: string;
  fromCache: boolean;
}

function renderIdentity(s: IdentitySummary): void {
  console.log();
  console.log(`  ${banner({ subtitle: "Identity" })}`);
  console.log();
  console.log(
    kvPanel([
      {
        icon: icon.ok,
        label: "Tenant",
        value: chalk.bold(s.name) + chalk.dim(`  (${s.slug})`),
      },
      {
        label: "Plan",
        value: s.plan ? chalk.bold(s.plan) : chalk.dim("unknown"),
      },
      {
        label: "Credits",
        value:
          s.credit_balance != null && s.credit_balance > 0
            ? chalk.bold(s.credit_balance.toLocaleString())
            : chalk.yellow("0  — top up at https://miosa.ai/billing"),
      },
      {
        label: "Region",
        value: s.region,
      },
      {
        label: "API key",
        value: chalk.dim(redactKey(s.api_key)),
      },
    ]),
  );
  if (s.fromCache) {
    console.log();
    console.log(
      `  ${chalk.dim("(cached — use ")}` +
        chalk.cyan("miosa whoami --refresh") +
        chalk.dim(" for live data)"),
    );
  }
  console.log();
}
