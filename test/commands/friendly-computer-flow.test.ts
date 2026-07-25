import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { register as registerComputers } from "../../src/commands/computers.js";
import { buildChoices } from "../../src/commands/menu.js";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerComputers(program);
  return program;
}

describe("friendly computer journey", () => {
  it("puts create and open at the top of the signed-in menu", () => {
    const choices = buildChoices(true);

    expect(choices.slice(0, 2)).toMatchObject([
      {
        label: "Create a computer",
        argv: ["computers", "create"],
      },
      {
        label: "Open a desktop",
        argv: ["computers", "open"],
      },
    ]);
  });

  it("teaches the simple create command without template internals", () => {
    const program = buildProgram();
    const computers = program.commands.find(
      (command) => command.name() === "computers",
    );
    const create = computers?.commands.find(
      (command) => command.name() === "create",
    );

    expect(create).toBeDefined();
    let help = "";
    create!.configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });
    create!.outputHelp();
    expect(help).toContain("miosa computers create --name boris");
    expect(help).toContain("small");
    expect(help).toContain("us-mia");
    expect(help).not.toContain("template_type");
  });

  it("provides a friendly open command with an optional computer", () => {
    const program = buildProgram();
    const computers = program.commands.find(
      (command) => command.name() === "computers",
    );
    const open = computers?.commands.find(
      (command) => command.name() === "open",
    );

    expect(open).toBeDefined();
    expect(open!.usage()).toBe("[options] [computer]");
  });
});
