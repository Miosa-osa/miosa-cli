import type { Command } from "commander";
import chalk from "chalk";
import {
  client,
  apiPath,
  enc,
  unwrap,
  runAction,
  type ApiObject,
  type JsonOptions,
} from "./enterprise-util.js";
import { hintBlock, icon, kvPanel, printBanner } from "../ui/render.js";
import { renderTable } from "../ui/table.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtVerified(v: unknown): string {
  if (v === true || v === "verified") return chalk.green("verified");
  if (v === false || v === "unverified" || v === "pending")
    return chalk.yellow("unverified");
  return chalk.dim(String(v ?? "—"));
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const domains = program
    .command("domains")
    .description("Manage custom domains on Computers");

  // ── list ───────────────────────────────────────────────────────────────────
  domains
    .command("list <computer-id>")
    .description("List all custom domains for a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiGet<unknown>(
            apiPath(`/computers/${enc(id)}/domains`),
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const rows = Array.isArray(value)
          ? (value.filter(
              (v) => v !== null && typeof v === "object" && !Array.isArray(v),
            ) as ApiObject[])
          : [];

        console.log();
        console.log(
          `  ${icon.info} ${chalk.bold(String(rows.length))} ${chalk.dim("domain(s)")}  ${chalk.dim(`computer: ${id}`)}`,
        );
        console.log();

        renderTable<ApiObject>(rows, [
          {
            header: "ID",
            key: (r) => chalk.dim(String(r["id"] ?? "—").slice(0, 12)),
            width: 14,
          },
          { header: "FQDN", key: (r) => chalk.bold(String(r["fqdn"] ?? "—")) },
          { header: "VERIFIED", key: (r) => fmtVerified(r["verified"]) },
          {
            header: "CREATED",
            key: (r) =>
              chalk.dim(String(r["inserted_at"] ?? r["created_at"] ?? "—")),
          },
        ]);

        console.log();
        console.log(
          hintBlock("Try", [
            `miosa domains add ${id} example.com`,
            `miosa domains verify ${id} <domain-id>`,
          ]),
        );
        console.log();
      }),
    );

  // ── add ────────────────────────────────────────────────────────────────────
  domains
    .command("add <computer-id> <fqdn>")
    .description("Register a custom FQDN for a Computer")
    .option("--json", "Output as JSON")
    .action((id: string, fqdn: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/computers/${enc(id)}/domains`),
            { fqdn },
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const domain = value as ApiObject;

        printBanner({ subtitle: "Domain registered" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "FQDN",
              value: chalk.bold(String(domain["fqdn"] ?? fqdn)),
            },
            {
              icon: icon.ok,
              label: "ID",
              value: chalk.dim(String(domain["id"] ?? "—")),
            },
            { label: "Verified", value: fmtVerified(domain["verified"]) },
            { label: "Computer", value: chalk.dim(id) },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Next", [
            `miosa domains verify ${id} ${String(domain["id"] ?? "<domain-id>")}`,
            `miosa domains list ${id}`,
          ]),
        );
        console.log();
      }),
    );

  // ── verify ─────────────────────────────────────────────────────────────────
  domains
    .command("verify <computer-id> <domain-id>")
    .description("Verify DNS ownership of a registered domain")
    .option("--json", "Output as JSON")
    .action((id: string, domainId: string, opts: JsonOptions) =>
      runAction(async () => {
        const value = unwrap(
          await client().apiPost<unknown>(
            apiPath(`/computers/${enc(id)}/domains/${enc(domainId)}/verify`),
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(value, null, 2));
          return;
        }

        const domain = value as ApiObject;

        printBanner({ subtitle: "Domain verification" });
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "Domain",
              value: chalk.bold(String(domain["fqdn"] ?? domainId)),
            },
            {
              icon: icon.ok,
              label: "Verified",
              value: fmtVerified(domain["verified"]),
            },
            { label: "Computer", value: chalk.dim(id) },
          ]),
        );
        console.log();
        console.log(hintBlock("Next", [`miosa domains list ${id}`]));
        console.log();
      }),
    );

  // ── delete ─────────────────────────────────────────────────────────────────
  domains
    .command("delete <computer-id> <domain-id>")
    .description("Delete a custom domain mapping")
    .option("--json", "Output as JSON")
    .action((id: string, domainId: string, opts: JsonOptions) =>
      runAction(async () => {
        await client().apiDelete<unknown>(
          apiPath(`/computers/${enc(id)}/domains/${enc(domainId)}`),
        );

        if (opts.json) {
          console.log(JSON.stringify({ deleted: true, id: domainId }, null, 2));
          return;
        }

        console.log();
        console.log(
          kvPanel([
            { icon: icon.ok, label: "Deleted", value: chalk.bold(domainId) },
            { label: "Computer", value: chalk.dim(id) },
          ]),
        );
        console.log();
        console.log(hintBlock("Try", [`miosa domains list ${id}`]));
        console.log();
      }),
    );
}
