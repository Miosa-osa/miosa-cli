import type { Command } from "commander";
import { loadConfig, saveConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { AuthError } from "../errors.js";
import type { ApiKey } from "../types.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("login")
    .description("Authenticate with your MIOSA API key")
    .option("--api-key <key>", "API key (msk_u_...)")
    .action(async (opts: { apiKey?: string }) => {
      let key: string | undefined = opts.apiKey;

      if (!key) {
        // Non-TTY pipe mode
        if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          key = Buffer.concat(chunks).toString().trim();
          if (!key) {
            console.error(
              "No API key provided. Pipe your key:\n  echo 'msk_u_...' | miosa login",
            );
            process.exit(1);
          }
        } else {
          // Interactive prompt
          const { default: inquirer } = await import("inquirer");
          const answer = await inquirer.prompt<{ key: string }>([
            {
              type: "password",
              name: "key",
              message: "Enter your MIOSA API key (msk_u_...):",
              validate: (v: string) =>
                v.startsWith("msk_") ? true : "Key must start with msk_",
            },
          ]);
          key = answer.key;
        }
      }

      // Validate the key against the API
      const config = loadConfig();
      const testConfig = { ...config, api_key: key as ApiKey };
      const client = new MiosaClient(testConfig);

      const spinner = spin("Validating API key...");
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
