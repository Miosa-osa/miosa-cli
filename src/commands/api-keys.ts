import type { Command } from "commander";
import chalk from "chalk";
import {
  client,
  deleteAndPrint,
  enc,
  postAndPrint,
  runAction,
  type JsonOptions,
  unwrap,
} from "./enterprise-util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";

interface ApiKey {
  id: string;
  name: string;
  scopes?: string[] | string | null;
  token?: string;
  key?: string;
  last_used_at?: string | null;
  created_at?: string;
  inserted_at?: string;
}

function unwrapKeys(raw: unknown): ApiKey[] {
  if (Array.isArray(raw)) return raw as ApiKey[];
  if (raw !== null && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of ["data", "keys", "api_keys", "items"]) {
      if (Array.isArray(r[key])) return r[key] as ApiKey[];
    }
  }
  return [];
}

function formatScopes(scopes: ApiKey["scopes"]): string {
  if (!scopes) return chalk.dim("all");
  if (Array.isArray(scopes)) return scopes.join(", ") || chalk.dim("none");
  return String(scopes);
}

export function register(program: Command): void {
  const apiKeys = program
    .command("api-keys")
    .description("Manage API keys for programmatic access");

  apiKeys
    .command("list")
    .description("List all API keys")
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOptions) => {
      await runAction(async () => {
        const spinner = spin("Fetching API keys...");
        const raw = await client().apiGet<unknown>("/api/v1/api-keys");
        spinner.stop();
        const keys = unwrapKeys(raw);

        if (opts.json) {
          console.log(JSON.stringify(keys, null, 2));
          return;
        }

        if (keys.length === 0) {
          console.log(chalk.dim("No API keys found."));
          return;
        }

        renderTable(keys, [
          { header: "ID", key: "id", width: 12 },
          { header: "NAME", key: "name", width: 28 },
          {
            header: "SCOPES",
            key: (k) => formatScopes(k.scopes),
            width: 32,
          },
          {
            header: "LAST USED",
            key: (k) =>
              k.last_used_at
                ? new Date(k.last_used_at).toLocaleString()
                : chalk.dim("never"),
            width: 20,
          },
          {
            header: "CREATED",
            key: (k) => {
              const ts = k.created_at ?? k.inserted_at;
              return ts ? new Date(ts).toLocaleString() : chalk.dim("-");
            },
            width: 20,
          },
        ]);
      });
    });

  apiKeys
    .command("create")
    .description(
      "Create a new API key — the plaintext token is shown only once",
    )
    .option("--name <name>", "Human-readable name for the key")
    .option(
      "--scopes <scopes>",
      'Comma-separated scopes, e.g. "computers:read,computers:write"',
    )
    .option("--json", "Output as JSON")
    .action(async (opts: JsonOptions & { name?: string; scopes?: string }) => {
      await runAction(async () => {
        if (!opts.name) {
          throw new Error("--name is required");
        }
        const body: Record<string, unknown> = { name: opts.name };
        if (opts.scopes) {
          body["scopes"] = opts.scopes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const spinner = spin("Creating API key...");
        const raw = await client().apiPost<unknown>("/api/v1/api-keys", body);
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(raw, null, 2));
          return;
        }

        const result =
          raw !== null && typeof raw === "object" && "data" in (raw as object)
            ? (raw as Record<string, unknown>)["data"]
            : raw;
        const key = result as ApiKey & { token?: string; key?: string };
        const plaintext = key.token ?? key.key;

        if (plaintext) {
          console.log(
            chalk.green(
              "API key created. Store this token — it won't be shown again:\n",
            ),
          );
          console.log(`  ${chalk.bold(plaintext)}\n`);
        }
        console.log(`${chalk.bold("id".padEnd(10))} ${key.id ?? ""}`);
        console.log(`${chalk.bold("name".padEnd(10))} ${key.name ?? ""}`);
        if (key.scopes) {
          console.log(
            `${chalk.bold("scopes".padEnd(10))} ${formatScopes(key.scopes)}`,
          );
        }
      });
    });

  apiKeys
    .command("create-scoped")
    .description("Create a short-lived scoped API key for one external user")
    .requiredOption("--external-user-id <id>", "External end-user identifier")
    .requiredOption(
      "--scopes <scopes>",
      'Comma-separated scopes, e.g. "sandboxes:read,sandboxes:exec"',
    )
    .option("--expires-at <iso>", "Optional ISO-8601 expiry timestamp")
    .option("--json", "Output as JSON")
    .action(
      async (
        opts: JsonOptions & {
          externalUserId: string;
          scopes: string;
          expiresAt?: string;
        },
      ) => {
        await runAction(async () => {
          const body: Record<string, unknown> = {
            external_user_id: opts.externalUserId,
            scopes: opts.scopes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          };
          if ((body["scopes"] as string[]).length === 0) {
            throw new Error("--scopes must include at least one scope");
          }
          if (opts.expiresAt) body["expires_at"] = opts.expiresAt;

          const spinner = spin("Creating scoped API key...");
          const raw = await client().apiPost<unknown>(
            "/api/v1/api-keys/scoped",
            body,
          );
          spinner.stop();
          const key = unwrap<ApiKey & { expires_at?: string }>(raw);

          if (opts.json) {
            console.log(JSON.stringify(key, null, 2));
            return;
          }

          const plaintext = key.token ?? key.key;
          if (plaintext) {
            console.log(
              chalk.green(
                "Scoped API key created. Store this token — it won't be shown again:\n",
              ),
            );
            console.log(`  ${chalk.bold(plaintext)}\n`);
          }
          console.log(`${chalk.bold("id".padEnd(10))} ${key.id ?? ""}`);
          console.log(
            `${chalk.bold("scopes".padEnd(10))} ${formatScopes(key.scopes)}`,
          );
          if (key.expires_at) {
            console.log(
              `${chalk.bold("expires".padEnd(10))} ${key.expires_at}`,
            );
          }
        });
      },
    );

  apiKeys
    .command("delete <id>")
    .description("Delete an API key by ID")
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`/api-keys/${enc(id)}`, opts)),
    );
}
