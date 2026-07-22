import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { handleError, isJsonMode } from "./util.js";
import type { BuildId, Deployment } from "../types.js";

function shortId(id: string): string {
  return id.slice(0, 8);
}

type ReleaseRow = Record<string, unknown> & { id: string; state?: string };

function stateColor(state: string | undefined): string {
  switch (state) {
    case "active":
    case "ready":
    case "succeeded":
      return chalk.green(state);
    case "failed":
    case "error":
      return chalk.red(state);
    case "building":
    case "deploying":
    case "queued":
      return chalk.yellow(state);
    case "cancelled":
    case "archived":
      return chalk.dim(state);
    default:
      return state ? chalk.dim(state) : chalk.dim("unknown");
  }
}

async function resolveApp(
  client: MiosaClient,
  nameOrId: string,
): Promise<Deployment> {
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
): Promise<{ app: Deployment; release: ReleaseRow }> {
  for (const app of await client.listDeployments()) {
    const release = (await listReleaseRows(client, app.id)).find((row) => row.id === releaseId);
    if (release) return { app, release };
  }
  throw new UserError(`Release not found: ${releaseId}`);
}

function responseRows(body: unknown, key: string): ReleaseRow[] {
  const value = body as Record<string, unknown> | null;
  const rows =
    value && Array.isArray(value[key])
      ? value[key]
      : value && Array.isArray(value["data"])
        ? value["data"]
        : [];
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .filter((row): row is ReleaseRow => typeof row["id"] === "string");
}

function textField(row: ReleaseRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function renderRelease(app: Deployment, release: ReleaseRow): void {
  console.log();
  console.log(`  ${chalk.bold("Release")}  ${release.id}`);
  console.log(`  ${chalk.bold("App")}      ${app.name} (${app.id})`);
  console.log(`  ${chalk.bold("State")}    ${stateColor(textField(release, "state"))}`);

  const versionNumber = release["version_number"];
  if (versionNumber !== undefined && versionNumber !== null) {
    console.log(`  ${chalk.bold("Version")}  ${String(versionNumber)}`);
  }

  console.log(
    `  ${chalk.bold("Source")}   ${
      textField(release, "source_sandbox_id") ??
      textField(release, "commit_sha") ??
      chalk.dim("none")
    }`,
  );

  const message =
    textField(release, "commit_message") ??
    textField(release, "kind") ??
    textField(release, "runtime_command");
  if (message) console.log(`  ${chalk.bold("Message")}  ${message}`);

  const error = textField(release, "error_message");
  if (error) console.log(`  ${chalk.bold("Error")}    ${chalk.red(error)}`);

  console.log(`  ${chalk.bold("Created")}  ${textField(release, "created_at") ?? chalk.dim("unknown")}`);
  console.log();
}

async function listReleaseRows(
  client: MiosaClient,
  appId: Deployment["id"],
): Promise<ReleaseRow[]> {
  const releaseBody = await client.apiGet<unknown>(
    `/api/v1/deployments/${encodeURIComponent(appId)}/releases`,
  );
  const releases = responseRows(releaseBody, "releases");
  if (releases.length > 0) return releases;

  const versionBody = await client.apiGet<unknown>(
    `/api/v1/deployments/${encodeURIComponent(appId)}/versions`,
  );
  const versions = responseRows(versionBody, "versions");
  if (versions.length > 0) return versions;

  const builds = await client.listBuilds(appId);
  return builds as unknown as ReleaseRow[];
}

async function getReleaseRow(
  client: MiosaClient,
  appId: Deployment["id"],
  releaseId: string,
): Promise<ReleaseRow> {
  try {
    const body = await client.apiGet<unknown>(
      `/api/v1/deployments/${encodeURIComponent(appId)}/releases/${encodeURIComponent(releaseId)}`,
    );
    const data = (body as Record<string, unknown> | null)?.["data"];
    if (data && typeof data === "object" && typeof (data as Record<string, unknown>)["id"] === "string") {
      return data as ReleaseRow;
    }
  } catch {
    // Fall back to immutable versions and legacy builds for older deployments.
  }

  try {
    const body = await client.apiGet<unknown>(
      `/api/v1/deployments/${encodeURIComponent(appId)}/versions/${encodeURIComponent(releaseId)}`,
    );
    const data = (body as Record<string, unknown> | null)?.["data"];
    if (data && typeof data === "object" && typeof (data as Record<string, unknown>)["id"] === "string") {
      return data as ReleaseRow;
    }
  } catch {
    // Fall back to legacy deployment builds for older deployments.
  }

  return client.getBuild(appId, releaseId as BuildId) as unknown as ReleaseRow;
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
        const rows = await listReleaseRows(client, app.id);

        if (isJsonMode(opts)) {
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
            header: "SOURCE",
            key: (row) =>
              textField(row, "source_sandbox_id")?.slice(0, 8) ??
              textField(row, "commit_sha")?.slice(0, 8) ??
              chalk.dim("none"),
            width: 10,
          },
          {
            header: "MESSAGE",
            key: (row) =>
              textField(row, "commit_message") ??
              textField(row, "kind") ??
              textField(row, "runtime_command") ??
              chalk.dim("none"),
            width: 32,
          },
          {
            header: "CREATED",
            key: (row) => textField(row, "created_at") ?? chalk.dim("unknown"),
            width: 24,
          },
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
      async (releaseId: string, opts: { app?: string; json?: boolean }) => {
        try {
          const client = new MiosaClient(loadConfig());
          let app: Deployment;
          let release: ReleaseRow;

          if (opts.app) {
            app = await resolveApp(client, opts.app);
            release = await getReleaseRow(client, app.id, releaseId);
          } else {
            ({ app, release } = await findRelease(client, releaseId));
          }

          if (isJsonMode(opts)) {
            console.log(JSON.stringify({ app, release }, null, 2));
            return;
          }

          renderRelease(app, release);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── releases get (alias for show) ──────────────────────────────────────────

  releases
    .command("get <deployment-id> <release-id>")
    .description("Get a release by deployment ID and release ID")
    .option("--json", "Output as JSON")
    .action(
      async (
        deploymentId: string,
        releaseId: string,
        opts: { json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const app = await resolveApp(client, deploymentId);
          const release = await getReleaseRow(client, app.id, releaseId);

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(release, null, 2));
            return;
          }

          renderRelease(app, release);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── releases promote ────────────────────────────────────────────────────────

  releases
    .command("promote <deployment-id> <version-id>")
    .description("Promote a version to active")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        deploymentId: string,
        versionId: string,
        opts: { yes?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const app = await resolveApp(client, deploymentId);

          if (!opts.yes) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `Promote version ${shortId(versionId)} on ${app.name}?`,
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("Cancelled."));
              return;
            }
          }

          const result = await client.apiPost<unknown>(
            `/api/v1/deployments/${encodeURIComponent(app.id)}/versions/${encodeURIComponent(versionId)}/promote`,
          );

          console.log(
            chalk.green(
              `Version ${shortId(versionId)} promoted on ${app.name}.`,
            ),
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  releases
    .command("promote-release <deployment-id> <release-id>")
    .description("Promote one exact immutable release to active")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        deploymentId: string,
        releaseId: string,
        opts: { yes?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const app = await resolveApp(client, deploymentId);

          if (!opts.yes) {
            const { default: inquirer } = await import("inquirer");
            const { ok } = await inquirer.prompt<{ ok: boolean }>([
              {
                type: "confirm",
                name: "ok",
                message: `Promote release ${shortId(releaseId)} on ${app.name}?`,
                default: false,
              },
            ]);
            if (!ok) {
              console.log(chalk.dim("Cancelled."));
              return;
            }
          }

          const result = await client.apiPost<unknown>(
            `/api/v1/deployments/${encodeURIComponent(app.id)}/releases/${encodeURIComponent(releaseId)}/promote`,
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(
            chalk.green(
              `Release ${shortId(releaseId)} promoted on ${app.name}.`,
            ),
          );
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
    .option("--json", "Output as JSON")
    .action(
      async (
        releaseId: string,
        opts: { app?: string; yes?: boolean; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const found = opts.app
            ? {
                app: await resolveApp(client, opts.app),
                release: undefined as ReleaseRow | undefined,
              }
            : await findRelease(client, releaseId);
          const app = found.app;
          const release =
            found.release ?? (await getReleaseRow(client, app.id, releaseId));
          const versionId =
            textField(release, "deployment_version_id") ?? release.id;

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

          const result = await client.apiPost<unknown>(
            `/api/v1/deployments/${encodeURIComponent(app.id)}/rollback`,
            { version_id: versionId },
          );

          if (isJsonMode(opts)) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(
            chalk.green(`Rollback queued for ${app.name} to ${releaseId}.`),
          );
        } catch (err) {
          handleError(err);
        }
      },
    );
}
