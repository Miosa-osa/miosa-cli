import type { Command } from "commander";
import { register as registerConnect } from "./connect.js";
import { register as registerHosts } from "./hosts.js";

/**
 * The first-class OpenComputers command group.
 *
 * `miosa connect` and `miosa hosts` remain supported as short compatibility
 * commands, but this group teaches customers the product boundary: MIOSA
 * manages the account and OpenComputers connects machines the customer owns.
 */
export function register(program: Command): void {
  const openComputers = program
    .command("opencomputers")
    .alias("oc")
    .description("Connect and manage machines you own through OpenComputers");

  registerConnect(openComputers, {
    command: "connect [name]",
    description: "Register a machine and print its one-time OSA install command",
  });

  registerHosts(openComputers, {
    command: "list",
    description: "List your connected OpenComputers hosts",
    emptyHint: "No hosts found. Add one with: miosa opencomputers connect <name>",
  });
}
