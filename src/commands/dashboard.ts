/**
 * `miosa dashboard` — mount the ink-based live dashboard.
 *
 * Kept minimal on purpose: this file is the bridge between commander
 * (which knows about CLI options + help text) and ink (which owns the
 * actual rendering). All UI logic lives in `src/tui/dashboard.tsx`.
 *
 * NOTE: don't confuse with `miosa watch <computer-id>` — that's the
 * per-computer SSE event stream. This is the tenant-wide live snapshot.
 */

import type { Command } from "commander";
import React from "react";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { errorEnvelope } from "../ui/render.js";

export function register(program: Command): void {
  program
    .command("dashboard")
    .description(
      "Live terminal dashboard — running computers, sandboxes, deployments, credits",
    )
    .action(async () => {
      const config = loadConfig();
      if (!config.api_key) {
        console.log();
        console.log(
          errorEnvelope({
            title: "Not signed in",
            body: "The live dashboard needs an API key to query the platform.",
            suggest: ["miosa login"],
          }),
        );
        process.exit(1);
      }

      if (!process.stdout.isTTY) {
        console.log();
        console.log(
          errorEnvelope({
            title: "TTY required",
            body: "The dashboard renders interactively and cannot be piped.",
            suggest: ["miosa status  # one-shot snapshot, scriptable"],
          }),
        );
        process.exit(2);
      }

      // Ink is loaded dynamically so cold-starting `miosa --help`
      // doesn't pay the React import cost on every invocation.
      const { render } = await import("ink");
      const { Dashboard } = await import("../tui/dashboard.js");

      const { waitUntilExit } = render(
        React.createElement(Dashboard, { config }),
      );
      try {
        await waitUntilExit();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`dashboard crashed: ${msg}`));
        process.exit(1);
      }
    });
}
