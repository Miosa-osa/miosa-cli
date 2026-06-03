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
import { UserError } from "../errors.js";
import { isJsonMode } from "../cli-env.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtVerified(v: unknown): string {
  if (v === true || v === "verified") return chalk.green("verified");
  if (v === false || v === "unverified" || v === "pending")
    return chalk.yellow("unverified");
  return chalk.dim(String(v ?? "—"));
}

function domainName(domain: ApiObject, fallback?: string): string {
  return String(domain["domain"] ?? domain["fqdn"] ?? fallback ?? "—");
}

function domainStatus(domain: ApiObject): string {
  const status = String(
    domain["status"] ?? domain["verification_status"] ?? "pending",
  );
  if (status === "active" || status === "verified") return chalk.green(status);
  if (status === "failed" || status === "error") return chalk.red(status);
  return chalk.yellow(status);
}

function appId(domain: ApiObject): string {
  return String(domain["deployment_id"] ?? domain["app_id"] ?? "—");
}

function printDomain(domain: ApiObject, fallback?: string): void {
  console.log();
  console.log(
    kvPanel([
      {
        icon: icon.info,
        label: "Domain",
        value: chalk.bold(domainName(domain, fallback)),
      },
      { label: "Status", value: domainStatus(domain) },
      { label: "App", value: chalk.dim(appId(domain)) },
      {
        label: "Target",
        value: chalk.dim(String(domain["verification_target"] ?? "—")),
      },
    ]),
  );

  const records = Array.isArray(domain["dns_records"])
    ? domain["dns_records"]
    : [];
  if (records.length > 0) {
    console.log();
    console.log(chalk.bold("DNS records"));
    renderTable(
      records.filter(
        (r): r is ApiObject =>
          r !== null && typeof r === "object" && !Array.isArray(r),
      ),
      [
        { header: "TYPE", key: (r) => String(r["type"] ?? "—"), width: 8 },
        { header: "NAME", key: (r) => String(r["name"] ?? "—"), width: 28 },
        { header: "VALUE", key: (r) => String(r["value"] ?? "—") },
      ],
    );
  }

  if (domain["instructions"]) {
    console.log();
    console.log(chalk.dim(String(domain["instructions"])));
  }
}

async function resolveAppId(app: string): Promise<string> {
  const c = client();

  try {
    const direct = unwrap<ApiObject>(
      await c.apiGet<unknown>(apiPath(`/deployments/${enc(app)}`)),
    );
    if (typeof direct["id"] === "string") return direct["id"];
  } catch {
    // Fall through to list lookup by name/slug.
  }

  const list = unwrap<unknown>(
    await c.apiGet<unknown>(apiPath("/deployments")),
  );
  const rows = Array.isArray(list)
    ? (list.filter(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v),
      ) as ApiObject[])
    : [];
  const match = rows.find(
    (row) => row["id"] === app || row["name"] === app || row["slug"] === app,
  );
  if (typeof match?.["id"] === "string") return match["id"];

  throw new UserError(`App not found: ${app}`);
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const domains = program
    .command("domains")
    .description("Manage custom domains on apps and Computers");

  domains
    .command("status <fqdn>")
    .description("Show a custom domain by hostname")
    .option("--json", "Output as JSON")
    .action((fqdn: string, opts: JsonOptions) =>
      runAction(async () => {
        const domain = unwrap<ApiObject>(
          await client().apiGet<unknown>(apiPath(`/domains/${enc(fqdn)}`)),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(domain, null, 2));
          return;
        }

        printBanner({ subtitle: "Domain status" });
        printDomain(domain, fqdn);
        console.log();
      }),
    );

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

        if (isJsonMode(opts)) {
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
    .command("add <target-or-fqdn> [fqdn]")
    .description("Register a custom FQDN for an app or Computer")
    .option("--app <app>", "App/deployment ID, name, or slug")
    .option("--json", "Output as JSON")
    .action(
      (
        targetOrFqdn: string,
        fqdnArg: string | undefined,
        opts: JsonOptions & { app?: string },
      ) =>
        runAction(async () => {
          let value: unknown;
          let targetLabel: string;
          let fqdn: string;

          if (opts.app) {
            fqdn = targetOrFqdn;
            const deploymentId = await resolveAppId(opts.app);
            targetLabel = deploymentId;
            value = unwrap(
              await client().apiPost<unknown>(apiPath("/domains"), {
                domain: fqdn,
                deployment_id: deploymentId,
              }),
            );
          } else {
            if (!fqdnArg) {
              throw new UserError(
                "Missing domain.",
                "Use `miosa domains add app.example.com --app <app>` or `miosa domains add <computer-id> app.example.com`.",
              );
            }
            const computerId = targetOrFqdn;
            fqdn = fqdnArg;
            targetLabel = computerId;
            value = unwrap(
              await client().apiPost<unknown>(
                apiPath(`/computers/${enc(computerId)}/domains`),
                { fqdn },
              ),
            );
          }

          if (isJsonMode(opts)) {
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
              { label: "Status", value: domainStatus(domain) },
              {
                label: opts.app ? "App" : "Computer",
                value: chalk.dim(targetLabel),
              },
            ]),
          );
          printDomain(domain, fqdn);
          console.log();
          console.log(
            hintBlock("Next", [
              opts.app
                ? `miosa domains verify ${fqdn}`
                : `miosa domains verify ${targetLabel} ${String(domain["id"] ?? "<domain-id>")}`,
              opts.app
                ? `miosa domains status ${fqdn}`
                : `miosa domains list ${targetLabel}`,
            ]),
          );
          console.log();
        }),
    );

  // ── verify ─────────────────────────────────────────────────────────────────
  domains
    .command("verify <target-or-fqdn> [domain-id]")
    .description("Verify DNS ownership of a registered domain")
    .option("--wait", "Retry verification until it succeeds or timeout elapses")
    .option("--timeout <sec>", "Wait timeout in seconds", "120")
    .option("--json", "Output as JSON")
    .action(
      (
        targetOrFqdn: string,
        domainId: string | undefined,
        opts: JsonOptions & { wait?: boolean; timeout: string },
      ) =>
        runAction(async () => {
          const timeoutSec = Number.parseInt(opts.timeout, 10);
          const deadline =
            Date.now() +
            (Number.isFinite(timeoutSec) ? timeoutSec : 120) * 1000;
          let value: unknown;

          while (true) {
            try {
              value = domainId
                ? unwrap(
                    await client().apiPost<unknown>(
                      apiPath(
                        `/computers/${enc(targetOrFqdn)}/domains/${enc(domainId)}/verify`,
                      ),
                    ),
                  )
                : unwrap(
                    await client().apiPost<unknown>(
                      apiPath(`/domains/${enc(targetOrFqdn)}/verify`),
                      {},
                    ),
                  );
              break;
            } catch (err) {
              if (!opts.wait || Date.now() >= deadline) throw err;
              await new Promise((resolve) => setTimeout(resolve, 5_000));
            }
          }

          if (isJsonMode(opts)) {
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
                value: chalk.bold(domainName(domain, domainId ?? targetOrFqdn)),
              },
              {
                icon: icon.ok,
                label: "Status",
                value: domainStatus(domain),
              },
              {
                label: domainId ? "Computer" : "App",
                value: chalk.dim(domainId ? targetOrFqdn : appId(domain)),
              },
            ]),
          );
          console.log();
          console.log(
            hintBlock("Next", [
              domainId
                ? `miosa domains list ${targetOrFqdn}`
                : `miosa domains status ${targetOrFqdn}`,
            ]),
          );
          console.log();
        }),
    );

  domains
    .command("assign <fqdn>")
    .description("Assign an existing custom domain to an app/deployment")
    .requiredOption("--app <app>", "App/deployment ID, name, or slug")
    .option("--json", "Output as JSON")
    .action((fqdn: string, opts: JsonOptions & { app: string }) =>
      runAction(async () => {
        const deploymentId = await resolveAppId(opts.app);
        const domain = unwrap<ApiObject>(
          await client().apiPost<unknown>(
            apiPath(`/domains/${enc(fqdn)}/assign`),
            {
              deployment_id: deploymentId,
            },
          ),
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(domain, null, 2));
          return;
        }

        printBanner({ subtitle: "Domain assigned" });
        printDomain(domain, fqdn);
        console.log();
      }),
    );

  // ── delete ─────────────────────────────────────────────────────────────────
  domains
    .command("delete <target-or-fqdn> [domain-id]")
    .description("Delete a custom domain mapping")
    .option("--json", "Output as JSON")
    .action(
      (targetOrFqdn: string, domainId: string | undefined, opts: JsonOptions) =>
        runAction(async () => {
          let value: unknown;

          if (domainId) {
            value = await client().apiDelete<unknown>(
              apiPath(
                `/computers/${enc(targetOrFqdn)}/domains/${enc(domainId)}`,
              ),
            );
          } else {
            value = unwrap(
              await client().apiDelete<unknown>(
                apiPath(`/domains/${enc(targetOrFqdn)}`),
              ),
            );
          }

          if (isJsonMode(opts)) {
            console.log(
              JSON.stringify(
                value ?? { deleted: true, id: domainId, domain: targetOrFqdn },
                null,
                2,
              ),
            );
            return;
          }

          console.log();
          console.log(
            kvPanel([
              {
                icon: icon.ok,
                label: "Deleted",
                value: chalk.bold(domainId ?? targetOrFqdn),
              },
              {
                label: domainId ? "Computer" : "Domain",
                value: chalk.dim(targetOrFqdn),
              },
            ]),
          );
          console.log();
          if (domainId)
            console.log(
              hintBlock("Try", [`miosa domains list ${targetOrFqdn}`]),
            );
          console.log();
        }),
    );
}
