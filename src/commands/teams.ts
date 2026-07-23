import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface OrganizationMember {
  id: string;
  user_id: string;
  email: string;
  name?: string;
  role?: string;
  created_at?: string;
}

interface OrganizationInvite {
  invite_id: string;
  email: string;
  role?: string;
  status?: string;
}

function unwrapMembers(
  raw:
    | { data?: OrganizationMember[]; members?: OrganizationMember[] }
    | OrganizationMember[],
): OrganizationMember[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.members ?? [];
}

function unwrapInvite(
  raw:
    | { data?: OrganizationInvite; invite?: OrganizationInvite }
    | OrganizationInvite,
): OrganizationInvite {
  if ("data" in raw && raw.data) return raw.data;
  if ("invite" in raw && raw.invite) return raw.invite;
  return raw as OrganizationInvite;
}

function fmtRole(role: string | undefined): string {
  if (!role) return chalk.dim("-");
  if (role === "admin") return chalk.yellow(role);
  return role;
}

function fmtStatus(status: string | undefined): string {
  if (!status) return chalk.dim("-");
  if (status === "active") return chalk.green(status);
  if (status === "pending") return chalk.cyan(status);
  return chalk.dim(status);
}

export function register(program: Command): void {
  const teams = program
    .command("teams")
    .description("Manage organization members and invitations");

  // list
  teams
    .command("list")
    .description("List organization members")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching organization members...");
        const rows = unwrapMembers(
          await client.apiGet("/api/v1/tenant/members"),
        );
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No organization members found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (m) => m.id.slice(0, 12), width: 14 },
          { header: "USER ID", key: (m) => m.user_id.slice(0, 12), width: 14 },
          { header: "EMAIL", key: "email", width: 32 },
          { header: "NAME", key: (m) => m.name ?? chalk.dim("-"), width: 22 },
          { header: "ROLE", key: (m) => fmtRole(m.role), width: 10 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // invite
  teams
    .command("invite <email>")
    .description("Invite a user to the organization")
    .option(
      "--role <role>",
      "Role to assign: owner, admin, member, or viewer",
      "member",
    )
    .option("--json", "Output raw JSON")
    .action(async (email: string, opts: { role: string; json?: boolean }) => {
      try {
        const role = opts.role;
        if (!["owner", "admin", "member", "viewer"].includes(role)) {
          console.error(
            chalk.red(`Invalid role "${role}". Use: owner, admin, member, viewer`),
          );
          process.exit(1);
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin(`Inviting ${email}...`);
        const invite = unwrapInvite(
          await client.apiPost("/api/v1/tenant/members", { email, role }),
        );
        spinner.succeed(`Invited ${email}`);

        if (opts.json) {
          console.log(JSON.stringify(invite, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("Invite ID")} ${invite.invite_id}`);
        console.log(`  ${chalk.bold("Email")}   ${invite.email}`);
        console.log(`  ${chalk.bold("Role")}    ${fmtRole(invite.role)}`);
        console.log(`  ${chalk.bold("Status")}  ${fmtStatus(invite.status)}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // remove
  teams
    .command("remove <member-id>")
    .description("Remove an organization member")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(
      async (memberId: string, opts: { force?: boolean; json?: boolean }) => {
        try {
          if (!opts.force) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.red(`Remove organization member ${memberId}?`),
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("  Cancelled."));
              process.exit(0);
            }
          }

          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin("Removing member...");
          const result = await client.apiDelete(
            `/api/v1/tenant/members/${encodeURIComponent(memberId)}`,
          );
          spinner.succeed("Member removed");
          if (opts.json)
            console.log(JSON.stringify(result ?? { ok: true }, null, 2));
        } catch (err) {
          handleError(err);
        }
      },
    );

  // role
  teams
    .command("role <member-id> <role>")
    .description("Update an organization member's role")
    .option("--json", "Output raw JSON")
    .action(async (memberId: string, role: string, opts: { json?: boolean }) => {
      try {
        if (!["owner", "admin", "member", "viewer"].includes(role)) {
          console.error(
            chalk.red(`Invalid role "${role}". Use: owner, admin, member, viewer`),
          );
          process.exit(1);
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin(`Updating role to ${role}...`);
        const result = await client.apiPatch(
          `/api/v1/tenant/members/${encodeURIComponent(memberId)}/role`,
          { role },
        );
        spinner.succeed(`Role updated to ${role}`);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("Member")}  ${memberId}`);
        console.log(`  ${chalk.bold("Role")}  ${fmtRole(role)}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}
