/**
 * `miosa` (no args) → contextual interactive menu.
 *
 * When the user types just `miosa` from a TTY, we show a brand banner +
 * their current sign-in state + a list of common actions. Picking one
 * recursively re-invokes the CLI as if they'd typed that command — so
 * the dispatched command gets all the normal argv parsing, help text,
 * and error handling for free.
 *
 * In a non-TTY (CI, pipe, redirected stdin) we skip the menu and fall
 * back to the default Commander help screen, since prompting would
 * just hang.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadAuthCache, loadConfig } from "../config.js";
import { banner, icon } from "../ui/render.js";

interface MenuChoice {
  /** Visible label. */
  label: string;
  /** argv suffix to feed back into the CLI when picked. */
  argv: string[];
  /** Optional dim hint shown next to the label. */
  hint?: string;
}

/**
 * Build the action list based on current sign-in state. Authenticated
 * users get the full workflow; unauthenticated users only see sign-in.
 */
function buildChoices(authenticated: boolean): MenuChoice[] {
  if (!authenticated) {
    return [
      {
        label: "Sign in to MIOSA",
        argv: ["login"],
        hint: "opens browser",
      },
      {
        label: "Read the docs",
        argv: [],
        hint: "https://miosa.ai/docs",
      },
    ];
  }
  return [
    { label: "Show platform status", argv: ["status"], hint: "live snapshot" },
    { label: "List my computers", argv: ["computers", "list"] },
    { label: "List my sandboxes", argv: ["sandbox", "list"] },
    { label: "List my deployments", argv: ["deploy", "list"] },
    {
      label: "Install MCP into Claude Code",
      argv: ["mcp", "install"],
      hint: "one-command setup",
    },
    { label: "Manage API tokens", argv: ["auth", "token", "list"] },
    { label: "Who am I?", argv: ["whoami"] },
    { label: "Sign out", argv: ["logout"] },
  ];
}

export function register(program: Command): void {
  program.action(async () => {
    // We only run the menu when Commander dispatched here because no
    // subcommand matched. If argv is longer than "node miosa", the user
    // typed something that Commander has already handled (or errored on).
    if (process.argv.length > 2) return;

    // Non-TTY → fall back to default help text. Prompting would hang.
    if (!process.stdin.isTTY) {
      program.help();
      return;
    }

    const config = loadConfig();
    const cache = config.api_key ? loadAuthCache() : null;
    const authenticated = Boolean(config.api_key);

    console.log();
    console.log(`  ${banner({})}`);
    console.log();
    if (authenticated) {
      const who = cache
        ? `${chalk.bold(cache.name)}${chalk.dim(` · ${cache.plan} plan`)}`
        : chalk.dim("(identity cache empty — try `miosa whoami --refresh`)");
      console.log(`  ${icon.ok}  Signed in as ${who}`);
    } else {
      console.log(`  ${icon.warn}  Not signed in`);
    }
    console.log();

    const choices = buildChoices(authenticated);

    const { default: inquirer } = await import("inquirer");
    const { picked } = await inquirer.prompt<{ picked: number }>([
      {
        type: "list",
        name: "picked",
        message: "What would you like to do?",
        pageSize: Math.min(10, choices.length),
        choices: choices.map((c, i) => ({
          name: c.hint ? `${c.label}  ${chalk.dim(c.hint)}` : c.label,
          value: i,
          short: c.label,
        })),
      },
    ]);

    const chosen = choices[picked];
    if (!chosen) return;

    // Docs is special — no argv to dispatch; just print the link.
    if (chosen.argv.length === 0) {
      console.log();
      console.log(`  ${icon.arrow} ${chalk.cyan("https://miosa.ai/docs")}`);
      console.log();
      return;
    }

    // Re-invoke Commander with the chosen argv. This goes through the
    // normal command lifecycle (option parsing, help, error handling) —
    // we don't need to duplicate any of that here.
    console.log();
    await program.parseAsync(["node", "miosa", ...chosen.argv], {
      from: "user",
    });
  });
}
