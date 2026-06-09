import { describe, expect, it } from "vitest";
import { Command } from "commander";

const { commandTree } = await import("../../src/commands/command-overview.js");

describe("miosa command-overview", () => {
  it("builds a command tree with aliases, options, and nested commands", () => {
    const program = new Command();
    program.name("miosa").description("MIOSA CLI").option("--json");
    const sandbox = program
      .command("sandbox")
      .alias("sbx")
      .description("Manage sandboxes");
    sandbox
      .command("create")
      .description("Create a sandbox")
      .option("--template <template>");

    const tree = commandTree(program);

    expect(tree).toMatchObject({
      name: "miosa",
      path: "miosa",
      options: ["--json"],
      children: [
        {
          name: "sandbox",
          path: "miosa sandbox",
          aliases: ["sbx"],
          children: [
            {
              name: "create",
              path: "miosa sandbox create",
              options: ["--template <template>"],
            },
          ],
        },
      ],
    });
  });
});
