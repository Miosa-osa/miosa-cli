import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  credit_balance?: number;
  region?: string | null;
  inserted_at?: string;
}

function unwrapTenants(raw: unknown): TenantSummary[] {
  if (Array.isArray(raw)) return raw as TenantSummary[];
  if (raw && typeof raw === "object" && "data" in raw) {
    const d = (raw as { data: unknown }).data;
    if (Array.isArray(d)) return d as TenantSummary[];
  }
  return [];
}

export function register(program: Command): void {
  const tenant = program
    .command("tenant")
    .alias("tenants")
    .description(
      "Manage tenant context — list orgs you belong to and switch active tenant",
    );

  // list
  tenant
    .command("list")
    .description("List all tenants available to this API key")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient({ ...config, tenant: null, workspace: null });
        const spinner = spin("Fetching tenants...");
        const rows = unwrapTenants(
          await client.apiGet("/api/v1/platform/tenants"),
        );
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("  No tenants found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (t) => t.id.slice(0, 12), width: 14 },
          { header: "NAME", key: "name", width: 24 },
          { header: "SLUG", key: "slug", width: 20 },
          { header: "PLAN", key: "plan", width: 10 },
          {
            header: "REGION",
            key: (t) => t.region ?? chalk.dim("default"),
            width: 12,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // switch — writes the active tenant slug to config. The API verifies the
  // caller is a member before honoring X-MIOSA-Tenant on requests.
  tenant
    .command("switch <slug>")
    .description(
      "Switch the active tenant context (writes to ~/.miosa/config.json)",
    )
    .option("--json", "Output raw JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient({ ...config, tenant: null, workspace: null });

        // Validate the tenant exists + we have access
        const spinner = spin(`Switching to tenant ${chalk.bold(slug)}...`);
        const rows = unwrapTenants(
          await client.apiGet("/api/v1/platform/tenants"),
        );
        const match = rows.find((t) => t.slug === slug || t.id === slug);
        if (!match) {
          spinner.fail(`Tenant not found: ${slug}`);
          console.error(
            chalk.dim(
              `  Available tenants: ${rows.map((t) => t.slug).join(", ") || "(none)"}`,
            ),
          );
          process.exit(1);
        }

        saveConfig({ tenant: match.slug });
        spinner.succeed(
          `Switched to tenant ${chalk.bold(match.name)} (${match.slug})`,
        );

        if (opts.json) {
          console.log(
            JSON.stringify({ tenant_id: match.id, slug: match.slug }, null, 2),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });
}
