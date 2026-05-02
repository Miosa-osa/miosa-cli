import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { ServerError, UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { handleError } from "./util.js";
import type { BuildId, Deployment, DeploymentBuild } from "../types.js";

interface ApiClient {
  apiPost<T>(path: string, body?: unknown): Promise<T>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function stateColor(state: DeploymentBuild["state"]): string {
  switch (state) {
    case "succeeded":
      return chalk.green(state);
    case "failed":
      return chalk.red(state);
    case "building":
      return chalk.yellow(state);
    case "queued":
    case "cancelled":
      return chalk.dim(state);
  }
}

async function resolveApp(client: MiosaClient, nameOrId: string): Promise<Deployment> {
  try {
    return await client.getDeployment(nameOrId as Deployment["id"]);
  } catch {
    const apps = await client.listDeployments();
    const match = apps.find(
      (app) =>
        app.id === nameOrId || app.name === nameOrId || app.slug === nameOrId,
    );
    if (!match) throw new UserError(`App not found: ${nameOrId}`);
    return match;
  }
}

async function findRelease(
  client: MiosaClient,
  releaseId: string,
): Promise<{ app: Deployment; release: DeploymentBuild }> {
  for (const app of await client.listDeployments()) {
    const release = (await client.listBuilds(app.id)).find(
      (build) => build.id === releaseId,
    );
    if (release) return { app, release };
  }
  throw new UserError(`Release not found: ${releaseId}`);
}

export function register(program: Command): void {
  const releases = program
    .command("releases")
    .description("Inspect app release/build history");

  releases
    .command("list [app]")
    .description("List releases for an app")
    .option("--json", "Output as JSON")
    .action(async (appArg: string | undefined, opts: { json?: boolean }) => {
      try {
        if (!appArg) {
          throw new UserError(
            "No app provided.",
            "Pass an app name, slug, or deployment ID.",
          );
        }

        const client = new MiosaClient(loadConfig());
        const app = await resolveApp(client, appArg);
        const rows = await client.listBuilds(app.id);

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim(`No releases found for ${app.name}.`));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (row) => shortId(row.id), width: 10 },
          { header: "STATE", key: (row) => stateColor(row.state), width: 12 },
          {
            header: "COMMIT",
            key: (row) => row.commit_sha?.slice(0, 8) ?? chalk.dim("none"),
            width: 10,
          },
          {
            header: "MESSAGE",
            key: (row) => row.commit_message ?? chalk.dim("none"),
            width: 32,
          },
          { header: "CREATED", key: "created_at", width: 24 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  releases
    .command("show <release-id>")
    .description("Show one release/build")
    .option("--app <app>", "App name, slug, or deployment ID")
    .option("--json", "Output as JSON")
    .action(
      async (
        releaseId: string,
        opts: { app?: string; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          let app: Deployment;
          let release: DeploymentBuild;

          if (opts.app) {
            app = await resolveApp(client, opts.app);
            release = await client.getBuild(app.id, releaseId as BuildId);
          } else {
            ({ app, release } = await findRelease(client, releaseId));
          }

          if (opts.json) {
            console.log(JSON.stringify({ app, release }, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Release")}  ${release.id}`);
          console.log(`  ${chalk.bold("App")}      ${app.name} (${app.id})`);
          console.log(`  ${chalk.bold("State")}    ${stateColor(release.state)}`);
          console.log(`  ${chalk.bold("Commit")}   ${release.commit_sha ?? chalk.dim("none")}`);
          if (release.commit_message) {
            console.log(`  ${chalk.bold("Message")}  ${release.commit_message}`);
          }
          if (release.error_message) {
            console.log(`  ${chalk.bold("Error")}    ${chalk.red(release.error_message)}`);
          }
          console.log(`  ${chalk.bold("Created")}  ${release.created_at}`);
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  releases
    .command("rollback <release-id>")
    .description("Rollback to a release")
    .option("--app <app>", "App name, slug, or deployment ID")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(
      async (
        releaseId: string,
        opts: { app?: string; yes?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const app = opts.app
            ? await resolveApp(client, opts.app)
            : (await findRelease(client, releaseId)).app;

          if (!opts.yes) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `Rollback ${app.name} to release ${shortId(releaseId)}?`,
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("Cancelled."));
              return;
            }
          }

          const api = client as unknown as Partial<ApiClient>;
          if (typeof api.apiPost !== "function") {
            throw new UserError(
              "Rollback is not available in this CLI build.",
              "The backend needs a first-class rollback route before this command can mutate releases.",
            );
          }

          try {
            await api.apiPost(
              `/api/v1/deployments/${encodeURIComponent(app.id)}/builds/${encodeURIComponent(releaseId)}/rollback`,
            );
          } catch (err) {
            if (
              err instanceof UserError &&
              err.message.toLowerCase().includes("not found")
            ) {
              throw new UserError(
                "Rollback is not available: backend route not found.",
                "Expected POST /api/v1/deployments/:id/builds/:release_id/rollback.",
              );
            }
            if (err instanceof ServerError && err.statusCode === 501) {
              throw new UserError(
                "Rollback is not available: backend route is not implemented.",
                "A first-class rollback API is required before this command can proceed.",
              );
            }
            throw err;
          }

          console.log(chalk.green(`Rollback queued for ${app.name} to ${releaseId}.`));
        } catch (err) {
          handleError(err);
        }
      },
    );
}
