import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { AuthError, UserError } from "../errors.js";
import type { ApiKey } from "../types.js";
import { spin } from "../ui/spinner.js";
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

async function browserLogin(
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const start = await postJson<CliAuthStart>(
    config.endpoint,
    "/api/v1/auth/cli/start",
    { client_name: "MIOSA CLI" },
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
    console.log(chalk.dim("  Browser opened. Waiting for approval…"));
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
      "Authenticate with an explicit API key (msk_…) instead of browser",
    )
    .action(async (opts: { apiKey?: string }) => {
      let key: string | undefined = opts.apiKey;

      // No --api-key flag: prefer browser OAuth on a TTY; accept piped key otherwise.
      if (!key) {
        if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          key = Buffer.concat(chunks).toString().trim();
          if (!key) {
            console.error(
              "No API key provided. Either run `miosa login` from a TTY (browser OAuth) or pipe a key:\n  echo 'msk_…' | miosa login",
            );
            process.exit(1);
          }
        } else {
          // TTY mode: do browser OAuth via the same flow as `miosa auth login`.
          try {
            await browserLogin(loadConfig());
          } catch (err) {
            if (err instanceof UserError || err instanceof AuthError) {
              console.error(chalk.red(`Error: ${err.message}`));
              process.exit(3);
            }
            throw err;
          }
          return;
        }
      }

      // Validate the explicit key.
      const config = loadConfig();
      const testConfig = { ...config, api_key: key as ApiKey };
      const client = new MiosaClient(testConfig);

      const spinner = spin("Validating API key…");
      try {
        const tenant = await client.getTenant();
        saveConfig({ api_key: key as ApiKey });
        spinner.succeed(
          `Logged in as ${tenant.name} (${tenant.plan} plan, ${tenant.credit_balance} credits)`,
        );
      } catch (err) {
        spinner.fail("Authentication failed");
        if (err instanceof AuthError) {
          console.error(`  ${err.message}`);
        } else {
          console.error(
            `  ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        process.exit(3);
      }
    });
}
