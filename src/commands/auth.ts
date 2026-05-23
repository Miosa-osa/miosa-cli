import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { handleError } from "./util.js";

/**
 * `miosa auth` — token management only.
 *
 * Auth lifecycle commands (`login`, `logout`, `whoami`) live at the top
 * level (`miosa login`, etc.) and ship from their own files
 * (login.ts / logout.ts / whoami.ts). This file is intentionally scoped
 * to `miosa auth token list|create|revoke` so there's a single canonical
 * place for each user-facing command — no more `miosa auth login` vs
 * `miosa login` drifting apart.
 */

interface ApiClient {
  apiGet<T>(path: string): Promise<T>;
  apiPost<T>(path: string, body?: unknown): Promise<T>;
  apiDelete<T>(path: string): Promise<T>;
}

interface ApiKeyRecord {
  id: string;
  key_prefix?: string;
  prefix?: string;
  name: string;
  key_type?: string;
  key_purpose?: string;
  rate_limit_rpm?: number;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

interface ApiKeyWithRaw extends ApiKeyRecord {
  key: string;
}

function requireApiMethods(client: MiosaClient): ApiClient {
  const api = client as unknown as Partial<ApiClient>;
  if (
    typeof api.apiGet !== "function" ||
    typeof api.apiPost !== "function" ||
    typeof api.apiDelete !== "function"
  ) {
    throw new UserError(
      "MiosaClient apiGet/apiPost/apiDelete methods are required for auth token management.",
      "This command is ready for the parent client API surface but cannot run until those methods are exposed.",
    );
  }
  return api as ApiClient;
}

function unwrapData<T>(payload: unknown, listKey?: string): T {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if ("data" in record) return record["data"] as T;
    if (listKey && Array.isArray(record[listKey])) return record[listKey] as T;
    if (listKey === "api_keys" && Array.isArray(record["keys"])) {
      return record["keys"] as T;
    }
  }
  return payload as T;
}

export function register(program: Command): void {
  const auth = program
    .command("auth")
    .description(
      "Manage API tokens (use `miosa login` / `logout` / `whoami` for sign-in)",
    );

  const token = auth.command("token").description("Manage API tokens");

  token
    .command("list")
    .description("List API tokens")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const api = requireApiMethods(client);
        const keys = unwrapData<ApiKeyRecord[]>(
          await api.apiGet<unknown>("/api/v1/api-keys"),
          "api_keys",
        );

        if (opts.json) {
          console.log(JSON.stringify(keys, null, 2));
          return;
        }

        if (keys.length === 0) {
          console.log(chalk.dim("No API tokens found."));
          return;
        }

        renderTable(keys, [
          { header: "ID", key: (key) => key.id.slice(0, 8), width: 10 },
          { header: "NAME", key: "name", width: 24 },
          {
            header: "PREFIX",
            key: (key) => key.key_prefix ?? key.prefix ?? chalk.dim("none"),
            width: 12,
          },
          { header: "STATUS", key: "status", width: 10 },
          {
            header: "LAST USED",
            key: (key) =>
              key.last_used_at
                ? new Date(key.last_used_at).toLocaleString()
                : chalk.dim("never"),
            width: 20,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  token
    .command("create")
    .description("Create an API token")
    .option("--name <name>", "Token name", "cli-token")
    .option("--rate-limit-rpm <n>", "Rate limit per minute")
    .option("--json", "Output as JSON")
    .action(
      async (opts: { name: string; rateLimitRpm?: string; json?: boolean }) => {
        try {
          const client = new MiosaClient(loadConfig());
          const api = requireApiMethods(client);
          const created = unwrapData<ApiKeyWithRaw>(
            await api.apiPost<unknown>("/api/v1/api-keys", {
              name: opts.name,
              rate_limit_rpm: opts.rateLimitRpm
                ? Number.parseInt(opts.rateLimitRpm, 10)
                : undefined,
            }),
          );

          if (opts.json) {
            console.log(JSON.stringify(created, null, 2));
            return;
          }

          console.log(
            chalk.green(`Created token ${created.name} (${created.id})`),
          );
          console.log();
          console.log(created.key);
          console.log();
          console.log(
            chalk.dim("Store this token now. It will not be shown again."),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );

  token
    .command("revoke <id>")
    .alias("delete")
    .description("Revoke an API token")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      try {
        if (!opts.yes) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: `Revoke API token ${id}?`,
              default: false,
            },
          ]);
          if (!ok) {
            console.log(chalk.dim("Cancelled."));
            return;
          }
        }

        const client = new MiosaClient(loadConfig());
        const api = requireApiMethods(client);
        const result = unwrapData<{ id: string; status: string }>(
          await api.apiDelete<unknown>(
            `/api/v1/api-keys/${encodeURIComponent(id)}`,
          ),
        );

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.green(`Revoked token ${result.id}.`));
      } catch (err) {
        handleError(err);
      }
    });
}
