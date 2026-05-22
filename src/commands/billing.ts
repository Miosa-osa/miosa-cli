import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface BillingUsage {
  period_start?: string;
  period_end?: string;
  compute_hours?: number;
  compute_cost_cents?: number;
  storage_gb?: number;
  storage_cost_cents?: number;
  egress_gb?: number;
  egress_cost_cents?: number;
  total_cost_cents?: number;
  currency?: string;
}

interface Invoice {
  id: string;
  number?: string;
  status?: string;
  amount_due?: number;
  amount_paid?: number;
  currency?: string;
  period_start?: string;
  period_end?: string;
  due_date?: string;
  hosted_invoice_url?: string;
  pdf_url?: string;
}

interface BillingPlan {
  name?: string;
  id?: string;
  interval?: string;
  amount_cents?: number;
  currency?: string;
  features?: string[];
  limits?: Record<string, unknown>;
  next_billing_date?: string;
  status?: string;
}

interface BillingPortal {
  url?: string;
  portal_url?: string;
}

function unwrapUsage(
  raw: { data?: BillingUsage } | BillingUsage,
): BillingUsage {
  if ("data" in raw && raw.data) return raw.data;
  return raw as BillingUsage;
}

function unwrapInvoices(
  raw: { data?: Invoice[]; invoices?: Invoice[] } | Invoice[],
): Invoice[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.invoices ?? [];
}

function unwrapPlan(raw: { data?: BillingPlan } | BillingPlan): BillingPlan {
  if ("data" in raw && raw.data) return raw.data;
  return raw as BillingPlan;
}

function unwrapPortal(
  raw:
    | { data?: BillingPortal; url?: string; portal_url?: string }
    | BillingPortal,
): BillingPortal {
  if ("data" in raw && raw.data) return raw.data;
  return raw as BillingPortal;
}

function fmtCents(cents: number | undefined, currency = "usd"): string {
  if (cents === undefined) return chalk.dim("-");
  const dollars = (cents / 100).toFixed(2);
  return `${currency.toUpperCase()} $${dollars}`;
}

function fmtInvoiceStatus(status: string | undefined): string {
  if (!status) return chalk.dim("-");
  if (status === "paid") return chalk.green(status);
  if (status === "open") return chalk.yellow(status);
  if (status === "void" || status === "uncollectible") return chalk.dim(status);
  return status;
}

export function register(program: Command): void {
  const billing = program
    .command("billing")
    .description("Manage billing, usage, and subscription");

  // usage
  billing
    .command("usage")
    .description("Show usage for the current billing period")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching usage...");
        const usage = unwrapUsage(await client.apiGet("/api/v1/billing/usage"));
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(usage, null, 2));
          return;
        }

        const currency = usage.currency ?? "usd";
        console.log();
        if (usage.period_start && usage.period_end) {
          console.log(
            chalk.dim(`  Period: ${usage.period_start} — ${usage.period_end}`),
          );
          console.log();
        }
        console.log(
          `  ${chalk.bold("Compute")}   ${usage.compute_hours !== undefined ? `${usage.compute_hours.toFixed(2)} hrs` : chalk.dim("-")}  ${fmtCents(usage.compute_cost_cents, currency)}`,
        );
        console.log(
          `  ${chalk.bold("Storage")}   ${usage.storage_gb !== undefined ? `${usage.storage_gb.toFixed(2)} GB` : chalk.dim("-")}  ${fmtCents(usage.storage_cost_cents, currency)}`,
        );
        console.log(
          `  ${chalk.bold("Egress")}    ${usage.egress_gb !== undefined ? `${usage.egress_gb.toFixed(2)} GB` : chalk.dim("-")}  ${fmtCents(usage.egress_cost_cents, currency)}`,
        );
        console.log();
        console.log(
          `  ${chalk.bold("Total")}     ${fmtCents(usage.total_cost_cents, currency)}`,
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // invoices
  billing
    .command("invoices")
    .description("List invoices")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching invoices...");
        const rows = unwrapInvoices(
          await client.apiGet("/api/v1/billing/invoices"),
        );
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No invoices found."));
          return;
        }

        renderTable(rows, [
          {
            header: "ID",
            key: (i) => (i.number ?? i.id).slice(0, 16),
            width: 18,
          },
          {
            header: "STATUS",
            key: (i) => fmtInvoiceStatus(i.status),
            width: 12,
          },
          {
            header: "AMOUNT",
            key: (i) => fmtCents(i.amount_due ?? i.amount_paid, i.currency),
            width: 14,
          },
          {
            header: "PERIOD",
            key: (i) =>
              i.period_start ? i.period_start.slice(0, 10) : chalk.dim("-"),
            width: 12,
          },
          {
            header: "DUE",
            key: (i) => (i.due_date ? i.due_date.slice(0, 10) : chalk.dim("-")),
            width: 12,
          },
          {
            header: "PDF",
            key: (i) => (i.pdf_url ? chalk.cyan("available") : chalk.dim("-")),
            width: 10,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // plan
  billing
    .command("plan")
    .description("Show current subscription plan and limits")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching plan...");
        const plan = unwrapPlan(await client.apiGet("/api/v1/billing/plan"));
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }

        console.log();
        console.log(
          `  ${chalk.bold("Plan")}    ${plan.name ?? chalk.dim("unknown")}`,
        );
        if (plan.status)
          console.log(
            `  ${chalk.bold("Status")}  ${plan.status === "active" ? chalk.green(plan.status) : plan.status}`,
          );
        if (plan.amount_cents !== undefined)
          console.log(
            `  ${chalk.bold("Price")}   ${fmtCents(plan.amount_cents, plan.currency ?? "usd")} / ${plan.interval ?? "month"}`,
          );
        if (plan.next_billing_date)
          console.log(`  ${chalk.bold("Renews")}  ${plan.next_billing_date}`);
        if (plan.limits && Object.keys(plan.limits).length > 0) {
          console.log();
          console.log(chalk.bold("  Limits"));
          for (const [key, val] of Object.entries(plan.limits)) {
            console.log(
              `    ${key.padEnd(22)} ${val !== null && val !== undefined ? String(val) : chalk.dim("unlimited")}`,
            );
          }
        }
        if (plan.features && plan.features.length > 0) {
          console.log();
          console.log(chalk.bold("  Features"));
          for (const feature of plan.features) {
            console.log(`    ${chalk.green("+")} ${feature}`);
          }
        }
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // upgrade
  billing
    .command("upgrade")
    .description("Open the billing portal to upgrade or manage your plan")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Generating billing portal link...");
        const portal = unwrapPortal(
          await client.apiPost("/api/v1/billing/portal", {}),
        );
        spinner.stop();

        const url = portal.url ?? portal.portal_url;

        if (opts.json) {
          console.log(JSON.stringify(portal, null, 2));
          return;
        }

        if (!url) {
          console.log(
            chalk.yellow(
              "No billing portal URL returned. Contact support at https://miosa.ai/support",
            ),
          );
          return;
        }

        console.log();
        console.log(
          `  Open this URL to manage your billing:\n\n  ${chalk.cyan(url)}\n`,
        );
      } catch (err) {
        handleError(err);
      }
    });
}
