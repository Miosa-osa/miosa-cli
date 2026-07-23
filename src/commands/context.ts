import type { Command } from "commander";
import chalk from "chalk";
import {
  applyNamedContext,
  contextFromConfig,
  deleteNamedContext,
  getContextsPath,
  loadConfig,
  loadContextStore,
  redactKey,
  saveConfigForActiveContext,
  saveNamedContext,
  type MiosaContext,
} from "../config.js";
import { UserError } from "../errors.js";
import { handleError, isJsonMode, printJson } from "./util.js";

type JsonOptions = { json?: boolean };

function jsonMode(opts: JsonOptions | Command): boolean {
  const direct = (opts as JsonOptions).json;
  const nested =
    typeof (opts as Command).opts === "function"
      ? ((opts as Command).opts() as JsonOptions).json
      : false;
  return Boolean(direct || nested || isJsonMode());
}

function contextForOutput(context: MiosaContext): Record<string, unknown> {
  return {
    name: context.name,
    endpoint: context.endpoint,
    api_key: redactKey(context.api_key),
    tenant: context.tenant,
    organization: context.organization,
    workspace: context.workspace,
    region: context.region,
    default_host: context.default_host,
    output: context.output,
    created_at: context.created_at,
    updated_at: context.updated_at,
  };
}

function assertContextName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new UserError(
      `Invalid context name: ${name}`,
      "Use letters, numbers, dots, underscores, and hyphens.",
    );
  }
}

function printContextTable(active: string | null, contexts: MiosaContext[]): void {
  if (contexts.length === 0) {
    console.log(chalk.dim("No contexts saved yet."));
    console.log(chalk.dim("Run: miosa context save <name>"));
    return;
  }

  const widths = {
    name: Math.max(7, ...contexts.map((ctx) => ctx.name.length + (ctx.name === active ? 2 : 0))),
    workspace: Math.max(9, ...contexts.map((ctx) => (ctx.workspace ?? "").length)),
    tenant: Math.max(6, ...contexts.map((ctx) => (ctx.tenant ?? "").length)),
  };

  console.log();
  console.log(
    [
      chalk.bold("Context".padEnd(widths.name)),
      chalk.bold("Workspace".padEnd(widths.workspace)),
      chalk.bold("Tenant".padEnd(widths.tenant)),
      chalk.bold("Endpoint"),
    ].join("  "),
  );

  for (const context of contexts) {
    const marker = context.name === active ? "* " : "  ";
    console.log(
      [
        `${marker}${context.name}`.padEnd(widths.name),
        (context.workspace ?? "-").padEnd(widths.workspace),
        (context.tenant ?? "-").padEnd(widths.tenant),
        context.endpoint,
      ].join("  "),
    );
  }
  console.log();
}

export function register(program: Command): void {
  const context = program
    .command("context")
    .alias("contexts")
    .description("Manage named CLI contexts for accounts, tenants, and workspaces");

  context
    .command("ls")
    .alias("list")
    .description("List saved contexts")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) => {
      try {
        const store = loadContextStore();
        const contexts = Object.values(store.contexts).sort((a, b) =>
          a.name.localeCompare(b.name),
        );

        if (jsonMode(opts)) {
          printJson({
            active: store.active,
            contexts: contexts.map(contextForOutput),
            path: getContextsPath(),
          });
          return;
        }

        printContextTable(store.active, contexts);
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("current")
    .description("Show the active context")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) => {
      try {
        const store = loadContextStore();
        const current = store.active ? store.contexts[store.active] : null;

        if (jsonMode(opts)) {
          printJson({
            active: store.active,
            context: current ? contextForOutput(current) : null,
          });
          return;
        }

        if (!current) {
          console.log(chalk.dim("No active context."));
          return;
        }
        printContextTable(store.active, [current]);
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("save <name>")
    .description("Save the current auth and scope settings as a named context")
    .option("--json", "Output as JSON")
    .action((name: string, opts: JsonOptions) => {
      try {
        assertContextName(name);
        const saved = saveNamedContext(name, contextFromConfig(name));

        if (jsonMode(opts)) {
          printJson({ ok: true, context: contextForOutput(saved) });
          return;
        }

        console.log(
          `${chalk.green("Saved")} context ${chalk.bold(name)} ${chalk.dim(`(${getContextsPath()})`)}`,
        );
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("use <name>")
    .description("Switch the active CLI context")
    .option("--json", "Output as JSON")
    .action((name: string, opts: JsonOptions) => {
      try {
        const applied = applyNamedContext(name);
        if (!applied) {
          throw new UserError(
            `Context not found: ${name}`,
            "Run: miosa context ls",
          );
        }

        if (jsonMode(opts)) {
          printJson({ ok: true, active: name, context: contextForOutput(applied) });
          return;
        }

        console.log(`${chalk.green("Using")} context ${chalk.bold(name)}`);
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("show <name>")
    .description("Show one saved context")
    .option("--json", "Output as JSON")
    .action((name: string, opts: JsonOptions) => {
      try {
        const store = loadContextStore();
        const saved = store.contexts[name];
        if (!saved) {
          throw new UserError(
            `Context not found: ${name}`,
            "Run: miosa context ls",
          );
        }

        if (jsonMode(opts)) {
          printJson({ context: contextForOutput(saved), active: store.active === name });
          return;
        }

        printContextTable(store.active, [saved]);
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("set <key> <value>")
    .description("Set default tenant, workspace, region, endpoint, or host in the active context")
    .option("--json", "Output as JSON")
    .action((key: string, value: string, opts: JsonOptions) => {
      try {
        const allowed = ["organization", "tenant", "workspace", "region", "endpoint", "default_host"] as const;
        if (!allowed.includes(key as (typeof allowed)[number])) {
          throw new UserError(
            `Unknown context key: ${key}`,
            `Valid keys: ${allowed.join(", ")}`,
          );
        }

        const patch = { [key]: value === "-" ? null : value } as Partial<MiosaContext>;
        const updated = saveConfigForActiveContext(patch);
        const config = loadConfig();

        if (jsonMode(opts)) {
          printJson({
            ok: true,
            active: loadContextStore().active,
            context: updated ? contextForOutput(updated) : null,
            config: {
              tenant: config.tenant,
              organization: config.organization,
              workspace: config.workspace,
              region: config.region,
              endpoint: config.endpoint,
              default_host: config.default_host,
            },
          });
          return;
        }

        console.log(`${chalk.dim("Set")} ${chalk.bold(key)} ${chalk.dim("=")} ${value}`);
        if (!updated) {
          console.log(chalk.dim("No active context saved; updated current config only."));
        }
      } catch (err) {
        handleError(err);
      }
    });

  context
    .command("rm <name>")
    .alias("delete")
    .description("Delete a saved context")
    .option("--json", "Output as JSON")
    .action((name: string, opts: JsonOptions) => {
      try {
        const deleted = deleteNamedContext(name);
        if (!deleted) {
          throw new UserError(
            `Context not found: ${name}`,
            "Run: miosa context ls",
          );
        }

        if (jsonMode(opts)) {
          printJson({ ok: true, deleted: name });
          return;
        }

        console.log(`${chalk.dim("Deleted")} context ${chalk.bold(name)}`);
      } catch (err) {
        handleError(err);
      }
    });
}
