import type { Command } from "commander";
import chalk from "chalk";
import {
  clearApiKey,
  loadAuthCache,
  loadConfig,
  redactKey,
  saveAuthCache,
  saveConfig,
} from "../config.js";
import { MiosaClient } from "../client.js";
import { AuthError, UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, printJson } from "./util.js";
import type { ApiKey } from "../types.js";
import { request } from "undici";
import { spawn } from "node:child_process";

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

async function readApiKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString().trim();
}

interface CliAuthStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function postJson<T>(
  endpoint: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request(`${endpoint.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: res.statusCode, body: parsed };
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function browserLogin(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const start = await postJson<CliAuthStart>(
    config.endpoint,
    "/api/v1/auth/cli/start",
    {
      client_name: "MIOSA CLI",
    },
  );

  if (start.status >= 400) {
    throw new UserError(`Could not start CLI auth flow: HTTP ${start.status}`);
  }

  const flow = start.body;
  console.log();
  console.log(chalk.bold("Authorize MIOSA CLI"));
  console.log();
  console.log(`  Open: ${chalk.cyan(flow.verification_uri_complete)}`);
  console.log(`  Code: ${chalk.bold(flow.user_code)}`);
  console.log();

  try {
    openUrl(flow.verification_uri_complete);
    console.log(chalk.dim("  Browser opened. Waiting for approval..."));
  } catch {
    console.log(chalk.dim("  Could not open a browser automatically."));
  }

  const deadline = Date.now() + flow.expires_in * 1000;
  const intervalMs = Math.max(flow.interval || 3, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postJson<{
      api_key?: string;
      error?: string;
      tenant?: { id?: string; slug?: string };
    }>(config.endpoint, "/api/v1/auth/cli/token", {
      device_code: flow.device_code,
    });

    if (poll.status === 200 && poll.body.api_key) {
      saveConfig({ api_key: poll.body.api_key as ApiKey });
      console.log(
        chalk.green("Logged in. API key saved to ~/.miosa/config.json"),
      );
      return;
    }

    if (poll.status === 428 || poll.body.error === "authorization_pending") {
      continue;
    }

    if (poll.body.error === "access_denied") {
      throw new UserError("CLI login was denied in the browser.");
    }

    if (poll.body.error === "expired_token" || poll.status === 410) {
      throw new UserError(
        "CLI login request expired. Run `miosa auth login` again.",
      );
    }

    throw new UserError(
      `CLI login failed: ${poll.body.error ?? `HTTP ${poll.status}`}`,
    );
  }

  throw new UserError("CLI login timed out. Run `miosa auth login` again.");
}

export function register(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage authentication and API tokens");

  auth
    .command("login")
    .description("Authenticate with your MIOSA API key")
    .option("--api-key <key>", "API key (msk_...)")
    .action(async (opts: { apiKey?: string }) => {
      let key = opts.apiKey;

      if (!key) {
        if (!process.stdin.isTTY) {
          key = await readApiKeyFromStdin();
        } else {
          try {
            await browserLogin(loadConfig());
          } catch (err) {
            handleError(err);
          }
          return;
        }
      }

      if (!key) {
        console.error("No API key provided. Pipe your key or pass --api-key.");
        process.exit(1);
      }

      const config = loadConfig();
      const authConfig = { ...config, api_key: key as ApiKey };
      const client = new MiosaClient(authConfig);
      const spinner = spin("Validating API key...");
      try {
        const tenant = await client.getTenant();
        saveConfig({ api_key: key as ApiKey });
        saveAuthCache({
          email: null,
          name: tenant.name,
          slug: tenant.slug,
          plan: tenant.plan,
          credit_balance: tenant.credit_balance,
          region: config.region,
          cached_at: new Date().toISOString(),
        });
        spinner.succeed(
          `Authenticated as ${tenant.name}` +
            chalk.dim(` (${tenant.plan} plan)`),
        );
      } catch (err) {
        spinner.fail("Authentication failed");
        if (err instanceof AuthError) console.error(`  ${err.message}`);
        else
          console.error(
            `  ${err instanceof Error ? err.message : String(err)}`,
          );
        process.exit(3);
      }
    });

  auth
    .command("logout")
    .description("Remove stored credentials and auth cache")
    .action(() => {
      const config = loadConfig();
      if (!config.api_key) {
        console.log(chalk.dim("Not logged in."));
        return;
      }
      clearApiKey(); // also clears auth cache
      console.log(
        chalk.green("Logged out. Credentials removed from ~/.miosa/"),
      );
    });

  auth
    .command("whoami")
    .description(
      "Show current identity (instant from cache; use --refresh for live data)",
    )
    .option("--json", "Output as JSON")
    .option("--refresh", "Force a network refresh of the cached identity")
    .action(async (opts: { json?: boolean; refresh?: boolean }) => {
      try {
        const config = loadConfig();

        if (!config.api_key) {
          if (opts.json) {
            printJson({ authenticated: false });
            return;
          }
          console.log(chalk.yellow("Not logged in. Run: miosa auth login"));
          process.exit(1);
        }

        // Fast path: serve from local cache unless --refresh
        const cached = opts.refresh ? null : loadAuthCache();

        if (cached) {
          if (opts.json) {
            printJson({
              authenticated: true,
              name: cached.name,
              slug: cached.slug,
              plan: cached.plan,
              credit_balance: cached.credit_balance,
              region: cached.region ?? config.region ?? "auto",
              api_key_prefix: redactKey(config.api_key),
              cached_at: cached.cached_at,
            });
            return;
          }

          const region = cached.region ?? config.region ?? "auto";
          console.log();
          console.log(`  ${chalk.bold("Endpoint")}  ${config.endpoint}`);
          console.log(
            `  ${chalk.bold("API Key")}   ${redactKey(config.api_key)}`,
          );
          console.log(
            `  ${chalk.bold("Tenant")}    ${cached.name} (${cached.slug})`,
          );
          console.log(`  ${chalk.bold("Plan")}      ${cached.plan}`);
          console.log(
            `  ${chalk.bold("Credits")}   ${cached.credit_balance.toLocaleString()}`,
          );
          console.log(`  ${chalk.bold("Region")}    ${region}`);
          console.log();
          return;
        }

        // Slow path: fetch live then cache
        const client = new MiosaClient(config);
        const tenant = await client.getTenant();

        saveAuthCache({
          email: null,
          name: tenant.name,
          slug: tenant.slug,
          plan: tenant.plan,
          credit_balance: tenant.credit_balance,
          region: config.region,
          cached_at: new Date().toISOString(),
        });

        if (opts.json) {
          printJson({
            authenticated: true,
            name: tenant.name,
            slug: tenant.slug,
            plan: tenant.plan,
            credit_balance: tenant.credit_balance,
            region: config.region ?? "auto",
            api_key_prefix: redactKey(config.api_key),
          });
          return;
        }

        const region = config.region ?? "auto";
        console.log();
        console.log(`  ${chalk.bold("Endpoint")}  ${config.endpoint}`);
        console.log(
          `  ${chalk.bold("API Key")}   ${redactKey(config.api_key)}`,
        );
        console.log(
          `  ${chalk.bold("Tenant")}    ${tenant.name} (${tenant.slug})`,
        );
        console.log(`  ${chalk.bold("Plan")}      ${tenant.plan}`);
        console.log(
          `  ${chalk.bold("Credits")}   ${tenant.credit_balance.toLocaleString()}`,
        );
        console.log(`  ${chalk.bold("Region")}    ${region}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

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
