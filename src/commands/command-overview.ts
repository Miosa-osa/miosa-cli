import type { Command, Option } from "commander";
import chalk from "chalk";
import { isJsonMode, printJson } from "./util.js";

interface CommandNode {
  name: string;
  path: string;
  aliases: string[];
  description: string;
  options: string[];
  children: CommandNode[];
}

function optionFlags(option: Option): string {
  return option.flags;
}

export function commandTree(command: Command, parentPath = ""): CommandNode {
  const name = command.name();
  const path = parentPath ? `${parentPath} ${name}` : name;
  const children = command.commands
    .map((child) => commandTree(child, path));

  return {
    name,
    path,
    aliases: command.aliases(),
    description: command.description(),
    options: command.options.map(optionFlags),
    children,
  };
}

function printTree(node: CommandNode, indent = "", isLast = true): void {
  const connector = indent ? (isLast ? "`- " : "+- ") : "";
  const aliasText =
    node.aliases.length > 0 ? chalk.dim(` (${node.aliases.join(", ")})`) : "";
  const description = node.description ? chalk.dim(` - ${node.description}`) : "";
  console.log(`${indent}${connector}${chalk.bold(node.name)}${aliasText}${description}`);

  const childIndent = indent + (indent ? (isLast ? "   " : "|  ") : "");
  node.children.forEach((child, index) => {
    printTree(child, childIndent, index === node.children.length - 1);
  });
}

export function register(program: Command): void {
  program
    .command("command-overview")
    .alias("commands")
    .description("Print a tree view of available MIOSA CLI commands")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const tree = commandTree(program);
      if (isJsonMode(opts)) {
        printJson(tree);
        return;
      }

      console.log();
      printTree(tree);
      console.log();
      console.log(chalk.dim("Use '<command> --help' for detailed flags and examples."));
      console.log(chalk.dim("Machine-readable form: miosa command-overview --json"));
      console.log();
    });
}
