import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, isJsonMode, parseEnvPairs, printJson } from "./util.js";

interface Secret {
  id: string;
  name: string;
  description?: string | null;
  host_id?: string | null;
  tenant_id?: string | null;
  inserted_at?: string;
  updated_at?: string;
}

interface SecretOptions {
  host?: string;
  machine?: string;
  app?: string;
  json?: boolean;
  description?: string;
}

function unwrapSecrets(raw: { data?: Secret[]; secrets?: Secret[] } | Secret[]): Secret[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.secrets ?? [];
}

async function secretBasePath(
  client: MiosaClient,
  opts: Pick<SecretOptions, "host" | "machine" | "app">,
): Promise<string> {
  const host = opts.host ?? opts.machine;
  if (opts.app) return `/api/v1/deployments/${encodeURIComponent(opts.app)}/env`;
  if (host) {
    const resolved = await client.getHost(host);
    return `/api/v1/opencomputers/hosts/${encodeURIComponent(resolved.id)}/secrets`;
  }
  return "/api/v1/opencomputers/secrets";
}

async function listSecrets(
  client: MiosaClient,
  opts: Pick<SecretOptions, "host" | "machine" | "app">,
): Promise<Secret[]> {
  return unwrapSecrets(await client.apiGet(await secretBasePath(client, opts)));
}

function assertSingleTarget(opts: Pick<SecretOptions, "host" | "machine" | "app">): void {
  const selected = [opts.host, opts.machine, opts.app].filter(Boolean);
  if (selected.length > 1) {
    throw new UserError("Choose only one target: --app, --host, or --machine.");
  }
}

async function deleteSecretByName(
  client: MiosaClient,
  name: string,
  opts: Pick<SecretOptions, "host" | "machine" | "app">,
): Promise<void> {
  const secret = (await listSecrets(client, opts)).find(
    (s) => s.name === name || s.id === name,
  );
  if (!secret) throw new UserError(`Secret not found: ${name}`);

  if (opts.app) {
    throw new UserError(
      "Unsetting deployment env vars is not supported by the current API.",
      "Set a replacement value with `miosa secrets set KEY=VALUE --app <id>`.",
    );
  }
  const basePath = await secretBasePath(client, opts);
  await client.apiDelete(`${basePath}/${encodeURIComponent(secret.id)}`);
}

export function register(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Manage tenant, host, and deployment secrets");

  secrets
    .command("list")
    .description("List secret names and metadata")
    .option("--host <host>", "Host ID or name for host-scoped secrets")
    .option("--machine <machine>", "Alias for --host")
    .option("--app <deployment>", "Deployment ID for app env vars")
    .option("--json", "Output raw JSON")
    .action(async (opts: SecretOptions) => {
      try {
        assertSingleTarget(opts);
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching secrets...");
        const rows = await listSecrets(client, opts);
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        renderTable(rows, [
          { header: "NAME", key: "name", width: 32 },
          {
            header: "SCOPE",
            key: (s) => (opts.app ? "app" : s.host_id ? "host" : "tenant"),
            width: 10,
          },
          {
            header: "DESCRIPTION",
            key: (s) => s.description ?? chalk.dim(""),
            width: 32,
          },
          {
            header: "UPDATED",
            key: (s) =>
              s.updated_at ? new Date(s.updated_at).toLocaleString() : chalk.dim("unknown"),
            width: 20,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  secrets
    .command("set <pairs...>")
    .description("Set one or more secrets as KEY=VALUE")
    .option("--host <host>", "Host ID or name for host-scoped secrets")
    .option("--machine <machine>", "Alias for --host")
    .option("--app <deployment>", "Deployment ID for app env vars")
    .option("--description <text>", "Description for created secrets")
    .option("--json", "Output raw JSON")
    .action(async (pairs: string[], opts: SecretOptions) => {
      try {
        assertSingleTarget(opts);
        const config = loadConfig();
        const client = new MiosaClient(config);
        const values = parseEnvPairs(pairs);
        const basePath = await secretBasePath(client, opts);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Setting secrets...");
        const results: unknown[] = [];

        if (opts.app) {
          results.push(await client.apiPost(basePath, values));
        } else {
          for (const [name, value] of Object.entries(values)) {
            results.push(
              await client.apiPost(basePath, {
                name,
                value,
                description: opts.description,
              }),
            );
          }
        }

        spinner?.succeed(`Set ${Object.keys(values).length} secret(s)`);
        if (json) {
          printJson(results);
          return;
        }
        for (const name of Object.keys(values)) {
          console.log(`  ${chalk.bold(name)}  ${chalk.dim("set")}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  secrets
    .command("unset <keys...>")
    .description("Delete one or more secrets by name or ID")
    .option("--host <host>", "Host ID or name for host-scoped secrets")
    .option("--machine <machine>", "Alias for --host")
    .option("--app <deployment>", "Deployment ID for app env vars")
    .action(async (keys: string[], opts: SecretOptions) => {
      try {
        assertSingleTarget(opts);
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Deleting secrets...");
        for (const key of keys) {
          await deleteSecretByName(client, key, opts);
        }
        spinner?.succeed(`Deleted ${keys.length} secret(s)`);
        if (json) {
          printJson({ ok: true, deleted: keys.length });
        }
      } catch (err) {
        handleError(err);
      }
    });

  secrets
    .command("reveal <key>")
    .description("Reveal a secret value when the API allows it")
    .option("--host <host>", "Host ID or name for host-scoped secrets")
    .option("--machine <machine>", "Alias for --host")
    .option("--json", "Output raw JSON")
    .action(async (key: string, opts: SecretOptions) => {
      try {
        assertSingleTarget(opts);
        if (opts.app) {
          throw new UserError("Deployment env vars cannot be revealed by the current API.");
        }
        const config = loadConfig();
        const client = new MiosaClient(config);
        const basePath = await secretBasePath(client, opts);
        const secret = (await listSecrets(client, opts)).find(
          (s) => s.name === key || s.id === key,
        );
        if (!secret) throw new UserError(`Secret not found: ${key}`);

        const result = await client.apiPost(
          `${basePath}/${encodeURIComponent(secret.id)}/reveal`,
        );
        if (isJsonMode(opts)) {
          printJson(result);
          return;
        }
        if (
          typeof result === "object" &&
          result !== null &&
          "data" in result &&
          typeof (result as { data: unknown }).data === "object" &&
          (result as { data: object }).data !== null &&
          "value" in ((result as { data: object }).data as { value?: unknown })
        ) {
          console.log(
            String(((result as { data: { value: unknown } }).data).value),
          );
          return;
        }
        if (typeof result === "object" && result !== null && "value" in result) {
          console.log(String((result as { value: unknown }).value));
          return;
        }
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        handleError(err);
      }
    });
}
