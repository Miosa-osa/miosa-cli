import type { Command } from "commander";
import chalk from "chalk";
import { clearApiKey, clearAuthCache, loadConfig } from "../config.js";
import { hintBlock, icon, kvPanel } from "../ui/render.js";

export function register(program: Command): void {
  program
    .command("logout")
    .description("Remove stored credentials and auth cache")
    .action(() => {
      const config = loadConfig();
      if (!config.api_key) {
        // Account switching can leave an old identity cache behind if the
        // token was cleared by another command/process first.
        clearAuthCache();
        console.log();
        console.log(`  ${icon.info}  ${chalk.dim("Not logged in.")}`);
        console.log();
        console.log(hintBlock("Sign in", ["miosa login"]));
        return;
      }

      // Note: this only clears the LOCAL cache. The msk_u_ key remains
      // valid server-side until explicitly revoked from API key settings.
      clearApiKey();

      console.log();
      console.log(
        kvPanel([
          {
            icon: icon.ok,
            label: "Signed out",
            value: chalk.dim("local credentials cleared"),
          },
          {
            icon: icon.warn,
            label: "Server-side",
            value: chalk.dim("key NOT revoked - visit API key settings to revoke"),
          },
        ]),
      );
      console.log();
      console.log(
        hintBlock("Next", [
          "miosa login",
          "https://miosa.ai/developer/api-keys  # to revoke server-side",
        ]),
      );
    });
}
