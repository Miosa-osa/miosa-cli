/**
 * MIOSA CLI resource picker.
 *
 * When a user runs a command that needs a sandbox / computer / deployment
 * id and they didn't supply one, we present a searchable list instead of
 * forcing them to grep `miosa computers list | awk …`.
 *
 * Built on the existing `inquirer` dep — no new packages. Dynamic import
 * keeps the cold-start fast for commands that never prompt.
 */

import chalk from "chalk";
import { UserError } from "../errors.js";

export interface PickItem<T = unknown> {
  /** Stable id used as the prompt return value. */
  id: string;
  /** First line of the choice as rendered. */
  label: string;
  /** Dim second-line metadata: status, region, age, etc. */
  hint?: string;
  /** Original record, returned to the caller for convenience. */
  data: T;
}

/**
 * Show a list, return the selected item. Throws `UserError` when the
 * list is empty so the caller can print a friendly "create one first"
 * message instead of an inquirer crash.
 *
 * @param items   Choices to render. Pre-filter to what's relevant for
 *                the command (e.g. `status === "active"` for `exec`).
 * @param prompt  The question shown above the list.
 */
export async function pickOne<T>(
  items: PickItem<T>[],
  prompt: string,
): Promise<PickItem<T>> {
  if (items.length === 0) {
    throw new UserError(
      "Nothing to pick from.",
      "Create a resource first, then re-run this command.",
    );
  }

  // If we're not on a TTY (CI, pipe), refuse to prompt — the caller
  // should have supplied the id explicitly. Surfacing the error here
  // is friendlier than hanging on stdin.
  if (!process.stdin.isTTY) {
    throw new UserError(
      "Cannot prompt for selection in a non-interactive shell.",
      "Pass the resource id explicitly.",
    );
  }

  const { default: inquirer } = await import("inquirer");
  const { picked } = await inquirer.prompt<{ picked: string }>([
    {
      type: "list",
      name: "picked",
      message: prompt,
      pageSize: Math.min(10, items.length),
      choices: items.map((it) => ({
        name: it.hint ? `${it.label}  ${chalk.dim(it.hint)}` : it.label,
        value: it.id,
        short: it.label,
      })),
    },
  ]);

  const found = items.find((it) => it.id === picked);
  if (!found) {
    // Defensive — inquirer should always return one of the supplied
    // values. If it doesn't, something is structurally wrong.
    throw new Error(`Picker returned unknown id: ${picked}`);
  }
  return found;
}

/**
 * Convenience helper for confirm dialogs. Returns the user's answer
 * (defaulting to `false`) and prints "Cancelled." + exits the parent
 * promise chain naturally when the user says no.
 *
 * Use this for any destructive action (`destroy`, `revoke`, `delete`).
 */
export async function confirm(
  message: string,
  opts: { default?: boolean } = {},
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // No TTY → assume "no" so scripts don't accidentally proceed.
    return false;
  }
  const { default: inquirer } = await import("inquirer");
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    {
      type: "confirm",
      name: "ok",
      message,
      default: opts.default ?? false,
    },
  ]);
  return ok;
}
