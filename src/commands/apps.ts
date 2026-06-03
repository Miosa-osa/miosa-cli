import { spawn } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, isJsonMode } from "./util.js";
import type { Deployment } from "../types.js";

interface ApiClient {
  apiPost<T>(path: string, body?: unknown): Promise<T>;
}

type App = Deployment & {
  public_url?: string | null;
  auto_subdomain?: string | null;
  custom_domain?: string | null;
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function stateColor(state: Deployment["state"]): string {
  switch (state) {
    case "running":
      return chalk.green(state);
    case "failed":
      return chalk.red(state);
    case "building":
      return chalk.yellow(state);
    case "pending":
    case "stopped":
      return chalk.dim(state);
  }
}

function unwrapData<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

async function resolveApp(client: MiosaClient, nameOrId: string): Promise<App> {
  try {
    return (await client.getDeployment(nameOrId as Deployment["id"])) as App;
  } catch {
    const apps = (await client.listDeployments()) as App[];
    const match = apps.find(
      (app) =>
        app.id === nameOrId || app.name === nameOrId || app.slug === nameOrId,
    );
    if (!match) throw new UserError(`App not found: ${nameOrId}`);
    return match;
  }
}

function appUrl(app: App, tenantSlug?: string): string | null {
  if (app.public_url) return app.public_url;
  if (app.custom_domain) return `https://${app.custom_domain}`;
  if (app.auto_subdomain) return app.auto_subdomain;
  if (tenantSlug && app.slug) return `https://${app.slug}.${tenantSlug}.miosa.app`;
  return null;
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function register(program: Command): void {
  const apps = program.command("apps").description("Manage MIOSA Deploy apps");

  apps
    .command("list")
    .alias("ls")
    .description("List apps")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const rows = (await client.listDeployments()) as App[];

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No apps found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (app) => shortId(app.id), width: 10 },
          { header: "NAME", key: "name", width: 24 },
          { header: "SLUG", key: "slug", width: 24 },
          { header: "STATE", key: (app) => stateColor(app.state), width: 10 },
          { header: "BRANCH", key: "branch", width: 12 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  apps
    .command("create <name>")
    .description("Create an app")
    .option("--repo <url>", "GitHub repository URL")
    .option("--branch <branch>", "Git branch", "main")
    .option("--build-command <cmd>", "Build command")
    .option("--run-command <cmd>", "Run command")
    .option("--no-auto-deploy", "Disable GitHub webhook auto-deploys")
    .option("--json", "Output as JSON")
    .action(
      async (
        name: string,
        opts: {
          repo?: string;
          branch: string;
          buildCommand?: string;
          runCommand?: string;
          autoDeploy: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const api = client as unknown as Partial<ApiClient>;
          if (typeof api.apiPost !== "function") {
            throw new UserError(
              "App creation requires MiosaClient.apiPost.",
              "The parent client API surface must expose apiPost for this command.",
            );
          }

          const spinner = isJsonMode(opts) ? null : spin("Creating app...");
          const app = unwrapData<App>(
            await api.apiPost<unknown>("/api/v1/deployments", {
              name,
              repo_url: opts.repo,
              branch: opts.branch,
              build_command: opts.buildCommand,
              run_command: opts.runCommand,
              auto_deploy: opts.autoDeploy,
            }),
          );
          spinner?.succeed(`Created app ${app.name} (${shortId(app.id)})`);

          if (isJsonMode(opts)) console.log(JSON.stringify(app, null, 2));
        } catch (err) {
          handleError(err);
        }
      },
    );

  apps
    .command("show <name-or-id>")
    .description("Show app details")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const [app, tenant] = await Promise.all([
          resolveApp(client, nameOrId),
          client.getTenant().catch(() => null),
        ]);

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(app, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("Name")}    ${app.name}`);
        console.log(`  ${chalk.bold("ID")}      ${app.id}`);
        console.log(`  ${chalk.bold("Slug")}    ${app.slug}`);
        console.log(`  ${chalk.bold("State")}   ${stateColor(app.state)}`);
        console.log(`  ${chalk.bold("Repo")}    ${app.repo_url}`);
        console.log(`  ${chalk.bold("Branch")}  ${app.branch}`);
        const url = appUrl(app, tenant?.slug);
        if (url) console.log(`  ${chalk.bold("URL")}     ${url}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  apps
    .command("open <name-or-id>")
    .description("Open an app in your browser")
    .option("--print", "Print the URL without opening a browser")
    .action(async (nameOrId: string, opts: { print?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const [app, tenant] = await Promise.all([
          resolveApp(client, nameOrId),
          client.getTenant().catch(() => null),
        ]);
        const url = appUrl(app, tenant?.slug);
        if (!url) throw new UserError(`No public URL is available for app ${nameOrId}`);

        console.log(url);
        if (!opts.print) openUrl(url);
      } catch (err) {
        handleError(err);
      }
    });

  apps
    .command("destroy <name-or-id>")
    .alias("delete")
    .description("Destroy an app")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-f, --force", "Alias for --yes")
    .option("--json", "Output as JSON")
    .action(
      async (
        nameOrId: string,
        opts: { yes?: boolean; force?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const app = await resolveApp(client, nameOrId);

          if (!opts.yes && !opts.force) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: chalk.red(
                  `Destroy app ${app.name} (${shortId(app.id)})? This is irreversible.`,
                ),
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("Cancelled."));
              return;
            }
          }

          const result = await client.deleteDeployment(app.id);
          if (isJsonMode(opts)) console.log(JSON.stringify(result, null, 2));
          else console.log(chalk.green(`Destroyed app ${app.name}`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}
