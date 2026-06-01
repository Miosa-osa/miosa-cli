import type { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  loadAuthCache,
  saveAuthCache,
  clearAuthCache,
  redactKey,
} from "../config.js";
import { MiosaClient } from "../client.js";
import { AuthError } from "../errors.js";
import {
  banner,
  errorEnvelope,
  hintBlock,
  icon,
  kvPanel,
} from "../ui/render.js";
import { handleError, isJsonMode, printJson } from "./util.js";

export function register(program: Command): void {
  program
    .command("whoami")
    .description("Verify and show current auth state")
    .option("--json", "Output as JSON")
    .option(
      "--cached",
      "Use cached identity without contacting the API. May be stale.",
    )
    .option("--refresh", "Deprecated alias for live verification")
    .action(
      async (opts: { json?: boolean; cached?: boolean; refresh?: boolean }) => {
        const json = isJsonMode(opts);
        const config = loadConfig();

        // ── Not signed in ────────────────────────────────────────────────
        if (!config.api_key) {
          if (json) {
            printJson({ authenticated: false });
            return;
          }
          console.log();
          console.log(`  ${icon.warn}  ${chalk.bold("Not signed in")}`);
          console.log();
          console.log(hintBlock("Sign in", ["miosa login"]));
          process.exit(1);
        }

        // ── Explicit cache path ─────────────────────────────────────────
        const cached = opts.cached ? loadAuthCache() : null;

        if (cached) {
          if (json) {
            printJson({
              authenticated: true,
              name: cached.name,
              slug: cached.slug,
              plan: cached.plan,
              credit_balance: cached.credit_balance,
              region: cached.region ?? config.region ?? "auto",
              api_key_prefix: redactKey(config.api_key),
              cached_at: cached.cached_at,
              cached: true,
              verified: false,
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

        // ── Live verification path ──────────────────────────────────────
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

          if (json) {
            printJson({
              authenticated: true,
              name: tenant.name,
              slug: tenant.slug,
              plan: tenant.plan,
              credit_balance: tenant.credit_balance,
              region: config.region ?? "auto",
              api_key_prefix: redactKey(config.api_key),
              cached: false,
              verified: true,
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
          if (err instanceof AuthError) {
            clearAuthCache();
          }
          if (json) {
            process.env["MIOSA_JSON"] = "1";
            return handleError(err);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.log();
          console.log(
            errorEnvelope({
              title: "Could not load identity",
              body: message,
              suggest: [
                "miosa login  # create a fresh API key/session",
                "miosa whoami --cached  # inspect stale local identity only",
              ],
              withDebugHint: true,
            }),
          );
          process.exit(err instanceof AuthError ? err.exitCode : 1);
        }
      },
    );
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
      `  ${chalk.yellow("(cached only — auth was not verified; run ")}` +
        chalk.cyan("miosa whoami") +
        chalk.yellow(" for live validation)"),
    );
  }
  console.log();
}
