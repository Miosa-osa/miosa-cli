import type { Command } from "commander";
import { loadConfig, saveConfig, saveAuthCache } from "../config.js";
import { MiosaClient } from "../client.js";
import { AuthError, UserError } from "../errors.js";
import type { ApiKey, Tenant } from "../types.js";
import { spin } from "../ui/spinner.js";
import {
  banner,
  errorEnvelope,
  hintBlock,
  icon,
  kvPanel,
  printElapsed,
  formatDuration,
} from "../ui/render.js";
import { request } from "undici";
import { spawn } from "node:child_process";
import chalk from "chalk";

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

/** Persist identity info so `whoami` can return instantly from cache. */
function cacheIdentity(
  tenant: Tenant,
  config: ReturnType<typeof loadConfig>,
): void {
  saveAuthCache({
    email: null, // platform API returns tenant, not user email
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan,
    credit_balance: tenant.credit_balance,
    region: config.region,
    cached_at: new Date().toISOString(),
  });
}

export async function browserLogin(
  config: ReturnType<typeof loadConfig>,
  requestedTenant?: string,
): Promise<void> {
  const start = await postJson<CliAuthStart>(
    config.endpoint,
    "/api/v1/auth/cli/start",
    {
      client_name: "MIOSA CLI",
      ...(requestedTenant ? { tenant: requestedTenant } : {}),
    },
  );

  if (start.status >= 400) {
    throw new UserError(`Could not start CLI auth flow: HTTP ${start.status}`);
  }

  const flow = start.body;
  const flowStart = Date.now();
  console.log();
  console.log(`  ${banner({ subtitle: "Sign in" })}`);
  console.log();
  console.log(
    kvPanel([
      { label: "Open", value: chalk.cyan(flow.verification_uri_complete) },
      { label: "Code", value: chalk.bold(flow.user_code) },
    ]),
  );
  console.log();

  try {
    openUrl(flow.verification_uri_complete);
    console.log(
      `  ${icon.pending} ${chalk.dim("Browser opened. Waiting for approval…")}`,
    );
  } catch {
    console.log(
      `  ${icon.warn}  ${chalk.dim("Could not open a browser automatically.")}`,
    );
  }

  const deadline = Date.now() + flow.expires_in * 1000;
  const intervalMs = Math.max(flow.interval || 3, 1) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postJson<{
      api_key?: string;
      error?: string;
      tenant?: { id?: string; slug?: string; name?: string };
    }>(config.endpoint, "/api/v1/auth/cli/token", {
      device_code: flow.device_code,
    });

    if (poll.status === 200 && poll.body.api_key) {
      const apiKey = poll.body.api_key as ApiKey;
      // CLI keys are tenant-bound. Persist the exact tenant returned by the
      // server so a prior context can never send this new key to a different
      // organization through X-MIOSA-Tenant.
      saveConfig({ api_key: apiKey, tenant: poll.body.tenant?.slug ?? null });

      // Fetch and cache identity for instant `whoami`. Cache failure is
      // non-fatal — the key still works, `whoami` will refetch on demand.
      let tenantName: string | undefined;
      let tenantPlan: string | undefined;
      try {
        const freshConfig = {
          ...config,
          api_key: apiKey,
          tenant: poll.body.tenant?.slug ?? null,
        };
        const client = new MiosaClient(freshConfig);
        const tenant = await client.getTenant();
        cacheIdentity(tenant, freshConfig);
        tenantName = tenant.name;
        tenantPlan = tenant.plan ?? undefined;
      } catch {
        /* cache unavailable */
      }

      console.log();
      console.log(
        kvPanel([
          {
            icon: icon.ok,
            label: "Authenticated",
            value: tenantName
              ? `${chalk.bold(tenantName)}${tenantPlan ? chalk.dim(` · ${tenantPlan} plan`) : ""}`
              : chalk.dim("(identity cache unavailable)"),
          },
          {
            icon: icon.ok,
            label: "Token saved",
            value: chalk.dim("~/.miosa/config.json"),
          },
        ]),
      );
      console.log();
      console.log(
        hintBlock("Next", [
          "miosa whoami",
          "miosa mcp install",
          "miosa computers list",
        ]),
      );
      printElapsed(formatDuration(Date.now() - flowStart));
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
        "CLI login request expired. Run `miosa login` again.",
      );
    }

    throw new UserError(
      `CLI login failed: ${poll.body.error ?? `HTTP ${poll.status}`}`,
    );
  }

  throw new UserError("CLI login timed out. Run `miosa login` again.");
}

export function register(program: Command): void {
  program
    .command("login")
    .description("Authenticate with MIOSA (opens browser by default)")
    .option(
      "--api-key <key>",
      "Authenticate with an explicit API key (msk_...)",
    )
    .option(
      "--stdin",
      "Read API key from stdin (for piping: echo 'msk_...' | miosa login --stdin)",
    )
    .option(
      "--tenant <tenant>",
      "Authorize this CLI session for a specific organization",
    )
    .action(async (opts: { apiKey?: string; stdin?: boolean; tenant?: string }) => {
      // Inside a sandbox the CLI is pre-authenticated via env; block interactive login.
      const sandboxId = process.env["MIOSA_SANDBOX_ID"];
      if (sandboxId) {
        console.error(
          chalk.yellow(
            `Already authenticated as sandbox ${sandboxId} (via env). ` +
              "Interactive login is disabled inside a sandbox.",
          ),
        );
        process.exit(1);
      }

      let key: string | undefined = opts.apiKey;

      // --stdin: read key from pipe regardless of TTY state
      if (!key && opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        key = Buffer.concat(chunks).toString().trim();
        if (!key) {
          console.error(
            "No API key received on stdin. Usage: echo 'msk_...' | miosa login --stdin",
          );
          process.exit(1);
        }
      }

      // No explicit key and not --stdin: prefer browser OAuth on TTY, accept piped key otherwise
      if (!key) {
        if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          key = Buffer.concat(chunks).toString().trim();
          if (!key) {
            console.error(
              "No API key provided. Either run `miosa login` from a TTY (browser OAuth) or pipe a key:\n  echo 'msk_...' | miosa login",
            );
            process.exit(1);
          }
        } else {
          // TTY — browser OAuth flow
          try {
            await browserLogin(loadConfig(), opts.tenant);
          } catch (err) {
            if (err instanceof UserError || err instanceof AuthError) {
              console.log();
              console.log(
                errorEnvelope({
                  title: "Sign-in failed",
                  body: err.message,
                  suggest: [
                    "miosa login  # try again",
                    "miosa login --api-key msk_u_…  # paste a key instead",
                  ],
                  withDebugHint: true,
                }),
              );
              process.exit(3);
            }
            throw err;
          }
          return;
        }
      }

      // Validate the explicit key against the API
      const config = loadConfig();
      const testConfig = { ...config, api_key: key as ApiKey };
      const client = new MiosaClient(testConfig);

      const validateStart = Date.now();
      const spinner = spin("Validating API key…");
      try {
        const tenant = await client.getTenant();
        saveConfig({ api_key: key as ApiKey });
        cacheIdentity(tenant, testConfig);
        spinner.stop();

        console.log();
        console.log(`  ${banner({ subtitle: "Sign in" })}`);
        console.log();
        console.log(
          kvPanel([
            {
              icon: icon.ok,
              label: "Authenticated",
              value:
                chalk.bold(tenant.name) +
                (tenant.plan ? chalk.dim(` · ${tenant.plan} plan`) : ""),
            },
            {
              icon: icon.ok,
              label: "Token saved",
              value: chalk.dim("~/.miosa/config.json"),
            },
          ]),
        );
        console.log();
        console.log(
          hintBlock("Next", [
            "miosa whoami",
            "miosa mcp install",
            "miosa computers list",
          ]),
        );
        printElapsed(formatDuration(Date.now() - validateStart));
      } catch (err) {
        spinner.stop();
        const message =
          err instanceof AuthError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        console.log();
        console.log(
          errorEnvelope({
            title: "Authentication failed",
            body: message,
            suggest: [
              "miosa login  # use browser device flow instead",
              "https://miosa.ai/dashboard/api-keys  # rotate your key",
            ],
            withDebugHint: true,
          }),
        );
        process.exit(3);
      }
    });
}
