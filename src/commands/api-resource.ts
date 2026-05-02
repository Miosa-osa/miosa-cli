import type { Command } from "commander";
import chalk from "chalk";
import { UserError } from "../errors.js";
import { renderTable, type Column } from "../ui/table.js";
import { createClient, handleError, listOf, objectOf, printJson, shortId } from "./util.js";

type Row = Record<string, unknown>;

export interface ResourceConfig {
  command: string;
  description: string;
  basePath: string | ((args: Record<string, string>) => string);
  listKeys?: string[];
  itemKeys?: string[];
  idName?: string;
  parentArgs?: Array<{ name: string; description: string }>;
  columns?: Column<Row>[];
  createBody?: (values: string[], opts: Record<string, unknown>) => unknown;
}

function pathOf(
  value: ResourceConfig["basePath"],
  args: Record<string, string>,
): string {
  return typeof value === "function" ? value(args) : value;
}

function defaultColumns(): Column<Row>[] {
  return [
    { header: "ID", key: (r) => shortId(String(r["id"] ?? "")), width: 10 },
    { header: "NAME", key: (r) => String(r["name"] ?? r["slug"] ?? "—"), width: 28 },
    { header: "STATE", key: (r) => String(r["state"] ?? r["status"] ?? "—"), width: 14 },
    {
      header: "UPDATED",
      key: (r) => String(r["updated_at"] ?? r["created_at"] ?? "—"),
      width: 24,
    },
  ];
}

function collectParentArgs(
  cfg: ResourceConfig,
  values: string[],
): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [i, arg] of (cfg.parentArgs ?? []).entries()) {
    const value = values[i];
    if (!value) throw new UserError(`Missing required argument: ${arg.name}`);
    args[arg.name] = value;
  }
  return args;
}

export function registerResourceGroup(program: Command, cfg: ResourceConfig): void {
  const group = program.command(cfg.command).description(cfg.description);
  const parentUsage = (cfg.parentArgs ?? []).map((a) => `<${a.name}>`).join(" ");
  const listSignature = ["list", parentUsage].filter(Boolean).join(" ");
  const idName = cfg.idName ?? "id";

  group
    .command(listSignature || "list")
    .alias("ls")
    .description(`List ${cfg.command}`)
    .option("--json", "Output raw JSON")
    .action(async (...raw: unknown[]) => {
      const opts = raw.pop() as { json?: boolean };
      try {
        const args = collectParentArgs(cfg, raw as string[]);
        const payload = await createClient().apiGet<unknown>(pathOf(cfg.basePath, args));
        const rows = listOf<Row>(payload, cfg.listKeys);
        if (opts.json) return printJson(rows);
        if (rows.length === 0) {
          console.log(chalk.dim(`No ${cfg.command} found.`));
          return;
        }
        renderTable(rows, cfg.columns ?? defaultColumns());
      } catch (err) {
        handleError(err);
      }
    });

  group
    .command(["show", parentUsage, `<${idName}>`].filter(Boolean).join(" "))
    .description(`Show one ${cfg.command} resource`)
    .option("--json", "Output raw JSON")
    .action(async (...raw: unknown[]) => {
      const opts = raw.pop() as { json?: boolean };
      try {
        const values = raw as string[];
        const args = collectParentArgs(cfg, values);
        const id = values[(cfg.parentArgs ?? []).length];
        if (!id) throw new UserError(`Missing required argument: ${idName}`);
        const payload = await createClient().apiGet<unknown>(
          `${pathOf(cfg.basePath, args)}/${encodeURIComponent(id)}`,
        );
        const item = objectOf<Row>(payload, cfg.itemKeys);
        if (opts.json) return printJson(item);
        for (const [key, value] of Object.entries(item)) {
          if (typeof value !== "object" || value === null) {
            console.log(`${chalk.bold(key)}: ${String(value)}`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  group
    .command(["destroy", parentUsage, `<${idName}>`].filter(Boolean).join(" "))
    .alias("delete")
    .description(`Delete one ${cfg.command} resource`)
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (...raw: unknown[]) => {
      const opts = raw.pop() as { force?: boolean };
      try {
        const values = raw as string[];
        const args = collectParentArgs(cfg, values);
        const id = values[(cfg.parentArgs ?? []).length];
        if (!id) throw new UserError(`Missing required argument: ${idName}`);
        if (!opts.force) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: chalk.red(`Delete ${cfg.command} ${id}?`),
              default: false,
            },
          ]);
          if (!ok) {
            console.log(chalk.dim("Cancelled."));
            return;
          }
        }
        await createClient().apiDelete<unknown>(
          `${pathOf(cfg.basePath, args)}/${encodeURIComponent(id)}`,
        );
        console.log(chalk.green(`Deleted ${cfg.command} ${id}`));
      } catch (err) {
        handleError(err);
      }
    });
}
