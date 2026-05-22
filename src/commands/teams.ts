import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface TeamMember {
  id: string;
  email: string;
  name?: string;
  role?: string;
  status?: string;
  invited_at?: string;
  joined_at?: string;
}

interface TeamInvite {
  id: string;
  email: string;
  role?: string;
  status?: string;
  invited_at?: string;
  expires_at?: string;
}

function unwrapMembers(
  raw: { data?: TeamMember[]; members?: TeamMember[] } | TeamMember[],
): TeamMember[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.members ?? [];
}

function unwrapInvite(
  raw: { data?: TeamInvite; invite?: TeamInvite } | TeamInvite,
): TeamInvite {
  if ("data" in raw && raw.data) return raw.data;
  if ("invite" in raw && raw.invite) return raw.invite;
  return raw as TeamInvite;
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
    .description("Manage team members and invitations");

  // list
  teams
    .command("list")
    .description("List team members")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching team members...");
        const rows = unwrapMembers(
          await client.apiGet("/api/v1/teams/members"),
        );
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No team members found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (m) => m.id.slice(0, 12), width: 14 },
          { header: "EMAIL", key: "email", width: 32 },
          { header: "NAME", key: (m) => m.name ?? chalk.dim("-"), width: 22 },
          { header: "ROLE", key: (m) => fmtRole(m.role), width: 10 },
          { header: "STATUS", key: (m) => fmtStatus(m.status), width: 10 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // invite
  teams
    .command("invite <email>")
    .description("Invite a user to the team")
    .option("--role <role>", "Role to assign: admin or member", "member")
    .option("--json", "Output raw JSON")
    .action(async (email: string, opts: { role: string; json?: boolean }) => {
      try {
        const role = opts.role;
        if (role !== "admin" && role !== "member") {
          console.error(
            chalk.red(`Invalid role "${role}". Use: admin, member`),
          );
          process.exit(1);
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin(`Inviting ${email}...`);
        const invite = unwrapInvite(
          await client.apiPost("/api/v1/teams/invites", { email, role }),
        );
        spinner.succeed(`Invited ${email}`);

        if (opts.json) {
          console.log(JSON.stringify(invite, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}      ${invite.id}`);
        console.log(`  ${chalk.bold("Email")}   ${invite.email}`);
        console.log(`  ${chalk.bold("Role")}    ${fmtRole(invite.role)}`);
        console.log(`  ${chalk.bold("Status")}  ${fmtStatus(invite.status)}`);
        if (invite.expires_at)
          console.log(`  ${chalk.bold("Expires")} ${invite.expires_at}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // remove
  teams
    .command("remove <user-id>")
    .description("Remove a team member")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(
      async (userId: string, opts: { force?: boolean; json?: boolean }) => {
        try {
          if (!opts.force) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.red(`Remove member ${userId} from the team?`),
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
            `/api/v1/teams/members/${encodeURIComponent(userId)}`,
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
    .command("role <user-id> <role>")
    .description("Update a team member's role (admin or member)")
    .option("--json", "Output raw JSON")
    .action(async (userId: string, role: string, opts: { json?: boolean }) => {
      try {
        if (role !== "admin" && role !== "member") {
          console.error(
            chalk.red(`Invalid role "${role}". Use: admin, member`),
          );
          process.exit(1);
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin(`Updating role to ${role}...`);
        const result = await client.apiPatch(
          `/api/v1/teams/members/${encodeURIComponent(userId)}`,
          { role },
        );
        spinner.succeed(`Role updated to ${role}`);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("User")}  ${userId}`);
        console.log(`  ${chalk.bold("Role")}  ${fmtRole(role)}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}
