import type { Command } from "commander";
import chalk from "chalk";
import { ActionAuthorityClient } from "../action-authority.js";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { renderTable } from "../ui/table.js";
import { handleError, isJsonMode, printJson } from "./util.js";

function authority(): ActionAuthorityClient {
  return new ActionAuthorityClient(new MiosaClient(loadConfig()));
}

function parseJson(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("--params and --constraints must be JSON objects.");
  }
  return parsed as Record<string, unknown>;
}

export function register(program: Command): void {
  const actions = program
    .command("actions")
    .description("Inspect and manage unified MIOSA agent-action authority");

  actions
    .command("catalog")
    .description("List server-owned, version-pinned action capabilities")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const catalog = await authority().catalog();
        if (isJsonMode(opts)) return printJson({ data: catalog });
        renderTable(catalog, [
          { header: "ACTION", key: "name", width: 30 },
          { header: "VERSION", key: "version", width: 10 },
          { header: "RISK", key: "risk", width: 12 },
          { header: "SCOPE", key: "scope", width: 12 },
          { header: "APPROVAL", key: "approval", width: 12 },
        ]);
      } catch (error) {
        handleError(error);
      }
    });

  actions
    .command("check <capability>")
    .description("Ask the authority whether one exact invocation may run")
    .option("--params <json>", "Exact action parameters", "{}")
    .option("--workspace <id>", "Workspace scope")
    .option("--invocation-id <id>", "Stable caller-provided invocation ID")
    .option("--json", "Output JSON")
    .action(
      async (
        capability: string,
        opts: {
          params?: string;
          workspace?: string;
          invocationId?: string;
          json?: boolean;
        },
      ) => {
        try {
          const decision = await authority().authorize(
            capability,
            parseJson(opts.params),
            {
              workspaceId: opts.workspace,
              invocationId: opts.invocationId,
            },
          );
          if (isJsonMode(opts)) return printJson(decision);
          console.log(
            decision.decision === "allow"
              ? chalk.green("ALLOW")
              : decision.decision === "pending_approval"
                ? chalk.yellow("PENDING APPROVAL")
                : chalk.red("DENY"),
          );
          if (decision.approval_request_id) {
            console.log(`Approval request: ${decision.approval_request_id}`);
          }
          if (decision.receipt_id)
            console.log(`Receipt: ${decision.receipt_id}`);
        } catch (error) {
          handleError(error);
        }
      },
    );

  const approvals = actions
    .command("approvals")
    .description("Manage one-time approvals");
  approvals
    .command("list")
    .option("--status <status>", "Filter by status")
    .option("--json", "Output JSON")
    .action(async (opts: { status?: string; json?: boolean }) => {
      try {
        const rows = await authority().approvals(opts.status);
        if (isJsonMode(opts)) return printJson({ data: rows });
        renderTable(rows, [
          { header: "ID", key: "id", width: 12 },
          { header: "ACTION", key: "capability_name", width: 28 },
          {
            header: "PRINCIPAL",
            key: (row) => `${row.principal_type}:${row.principal_id}`,
            width: 28,
          },
          { header: "STATUS", key: "status", width: 12 },
          { header: "CREATED", key: "inserted_at", width: 24 },
        ]);
      } catch (error) {
        handleError(error);
      }
    });

  for (const decision of ["approve", "deny"] as const) {
    approvals
      .command(`${decision} <id>`)
      .description(
        `${decision === "approve" ? "Approve" : "Deny"} one exact invocation`,
      )
      .option("--json", "Output JSON")
      .action(async (id: string, opts: { json?: boolean }) => {
        try {
          const result = await authority().resolveApproval(id, decision);
          if (isJsonMode(opts)) return printJson({ data: result });
          console.log(`${result.id}: ${result.status}`);
        } catch (error) {
          handleError(error);
        }
      });
  }

  const grants = actions
    .command("grants")
    .description("Manage standing action grants");
  grants
    .command("list")
    .option("--status <status>", "Filter by status")
    .option("--json", "Output JSON")
    .action(async (opts: { status?: string; json?: boolean }) => {
      try {
        const rows = await authority().grants(opts.status);
        if (isJsonMode(opts)) return printJson({ data: rows });
        renderTable(rows, [
          { header: "ID", key: "id", width: 12 },
          { header: "ACTION", key: "capability_name", width: 28 },
          {
            header: "PRINCIPAL",
            key: (row) => `${row.principal_type}:${row.principal_id}`,
            width: 28,
          },
          { header: "STATUS", key: "status", width: 12 },
          {
            header: "EXPIRES",
            key: (row) => row.expires_at ?? "never",
            width: 24,
          },
        ]);
      } catch (error) {
        handleError(error);
      }
    });

  grants
    .command("create <capability>")
    .requiredOption(
      "--principal-type <type>",
      "user, api_key, osa, optimal, schedule, opencomputer, mcp, or service",
    )
    .requiredOption("--principal-id <id>", "Exact principal ID")
    .option("--workspace <id>", "Optional workspace restriction")
    .option("--expires-at <iso8601>", "Optional expiration")
    .option("--constraints <json>", "Additional fail-closed constraints", "{}")
    .option("--json", "Output JSON")
    .action(
      async (
        capabilityName: string,
        opts: {
          principalType: string;
          principalId: string;
          workspace?: string;
          expiresAt?: string;
          constraints?: string;
          json?: boolean;
        },
      ) => {
        try {
          const client = authority();
          const capability = await client.requireCapability(capabilityName);
          const grant = await client.createGrant({
            capability: {
              name: capability.name,
              fingerprint: capability.fingerprint,
            },
            principal_type: opts.principalType,
            principal_id: opts.principalId,
            ...(opts.workspace ? { workspace_id: opts.workspace } : {}),
            ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
            constraints: parseJson(opts.constraints),
          });
          if (isJsonMode(opts)) return printJson({ data: grant });
          console.log(chalk.green(`Grant created: ${grant.id}`));
        } catch (error) {
          handleError(error);
        }
      },
    );

  grants
    .command("revoke <id>")
    .description("Revoke a standing grant immediately")
    .option("--json", "Output JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const grant = await authority().revokeGrant(id);
        if (isJsonMode(opts)) return printJson({ data: grant });
        console.log(chalk.green(`Grant revoked: ${grant.id}`));
      } catch (error) {
        handleError(error);
      }
    });

  actions
    .command("receipts")
    .description("List immutable action authority receipts")
    .option("--limit <count>", "Maximum rows", "100")
    .option("--json", "Output JSON")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      try {
        const parsedLimit = Number.parseInt(opts.limit ?? "100", 10);
        const limit =
          Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 100 : parsedLimit;
        const rows = await authority().receipts(limit);
        if (isJsonMode(opts)) return printJson({ data: rows });
        renderTable(rows, [
          { header: "TIME", key: "occurred_at", width: 24 },
          { header: "ACTION", key: "capability_name", width: 28 },
          { header: "SURFACE", key: "surface", width: 14 },
          { header: "DECISION", key: "decision", width: 20 },
          { header: "RECEIPT", key: "id", width: 12 },
        ]);
      } catch (error) {
        handleError(error);
      }
    });
}
