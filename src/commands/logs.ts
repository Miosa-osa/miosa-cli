import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { UserError } from "../errors.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import type { Deployment } from "../types.js";

// ── Resource type detection ───────────────────────────────────────────────────

type ResourceKind = "deployment" | "computer" | "sandbox";

interface ResourceHint {
  kind: ResourceKind;
  id: string;
}

/**
 * Auto-detect whether a resource ID belongs to a deployment, computer, or sandbox
 * by probing each API in order of likelihood. Falls back to deployment logs.
 */
async function detectResource(
  client: MiosaClient,
  resourceId: string,
): Promise<ResourceHint> {
  // Try deployment first (most common for `miosa logs`)
  try {
    await client.getDeployment(resourceId as Deployment["id"]);
    return { kind: "deployment", id: resourceId };
  } catch {
    // not a deployment
  }

  // Try computer
  try {
    await client.apiGet<unknown>(
      `/api/v1/computers/${encodeURIComponent(resourceId)}`,
    );
    return { kind: "computer", id: resourceId };
  } catch {
    // not a computer
  }

  // Try sandbox
  try {
    await client.apiGet<unknown>(
      `/api/v1/sandboxes/${encodeURIComponent(resourceId)}`,
    );
    return { kind: "sandbox", id: resourceId };
  } catch {
    // not a sandbox
  }

  throw new UserError(
    `Resource not found: ${resourceId}`,
    "Pass a deployment name/ID, computer ID, or sandbox ID.",
  );
}

async function resolveAppId(
  client: MiosaClient,
  appArg: string | undefined,
): Promise<Deployment["id"]> {
  if (!appArg) return resolveDeploymentId();

  try {
    return (await client.getDeployment(appArg as Deployment["id"])).id;
  } catch {
    const app = (await client.listDeployments()).find(
      (candidate) =>
        candidate.id === appArg ||
        candidate.name === appArg ||
        candidate.slug === appArg,
    );
    if (!app) throw new UserError(`App not found: ${appArg}`);
    return app.id;
  }
}

function printMachineLogs(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (Array.isArray(payload)) {
    for (const row of payload) console.log(JSON.stringify(row));
    return;
  }
  if (payload && typeof payload === "object" && "data" in payload) {
    printMachineLogs((payload as { data: unknown }).data, json);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function streamSse(
  res: Awaited<ReturnType<MiosaClient["streamDeploymentLogs"]>>,
): Promise<void> {
  for await (const event of parseSse(res.body)) {
    switch (event.type) {
      case "stdout":
        process.stdout.write(event.data);
        break;
      case "stderr":
        process.stderr.write(chalk.red(event.data));
        break;
      case "error":
        console.error(chalk.red(event.message));
        break;
      case "done":
        return;
      case "unknown":
        try {
          const parsed = JSON.parse(event.raw) as Record<string, unknown>;
          if (typeof parsed["line"] === "string") {
            const line = parsed["line"];
            if (parsed["stream"] === "stderr") {
              process.stderr.write(chalk.red(line) + "\n");
            } else {
              process.stdout.write(line + "\n");
            }
          }
        } catch {
          // Ignore malformed stream frames.
        }
        break;
      default:
        break;
    }
  }
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  program
    .command("logs [resource-id]")
    .description(
      "Stream logs — auto-detects computer, deployment, or sandbox by ID",
    )
    .option("--machine <id>", "Explicitly fetch logs for a computer/machine")
    .option("--sandbox <id>", "Explicitly fetch logs for a sandbox")
    .option("--json", "Output raw JSON")
    .addHelpText(
      "after",
      `
Examples:
  miosa logs                          Stream logs for linked deployment
  miosa logs <deployment-id>          Stream deployment logs
  miosa logs <computer-id>            Stream computer logs (auto-detected)
  miosa logs <sandbox-id>             Stream sandbox logs (auto-detected)
  miosa logs --machine <id>           Explicit computer logs
  miosa logs --sandbox <id>           Explicit sandbox logs
`,
    )
    .action(
      async (
        resourceId: string | undefined,
        opts: { machine?: string; sandbox?: string; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());

          // ── Explicit computer flag ────────────────────────────────────────
          if (opts.machine) {
            const payload = await client.apiGet<unknown>(
              `/api/v1/computers/${encodeURIComponent(opts.machine)}/logs`,
            );
            printMachineLogs(payload, opts.json ?? false);
            return;
          }

          // ── Explicit sandbox flag ─────────────────────────────────────────
          if (opts.sandbox) {
            const payload = await client.apiGet<unknown>(
              `/api/v1/sandboxes/${encodeURIComponent(opts.sandbox)}/logs`,
            );
            printMachineLogs(payload, opts.json ?? false);
            return;
          }

          // ── Auto-detect resource kind ─────────────────────────────────────
          if (resourceId) {
            const hint = await detectResource(client, resourceId);

            switch (hint.kind) {
              case "computer": {
                console.log(
                  chalk.dim(`Fetching computer logs for ${hint.id}...`),
                );
                const payload = await client.apiGet<unknown>(
                  `/api/v1/computers/${encodeURIComponent(hint.id)}/logs`,
                );
                printMachineLogs(payload, opts.json ?? false);
                return;
              }
              case "sandbox": {
                console.log(
                  chalk.dim(`Fetching sandbox logs for ${hint.id}...`),
                );
                const payload = await client.apiGet<unknown>(
                  `/api/v1/sandboxes/${encodeURIComponent(hint.id)}/logs`,
                );
                printMachineLogs(payload, opts.json ?? false);
                return;
              }
              case "deployment": {
                console.log(
                  chalk.dim(`Streaming deployment logs for ${hint.id}...`),
                );
                const res = await client.streamDeploymentLogs(
                  hint.id as Deployment["id"],
                );
                await streamSse(res);
                return;
              }
            }
          }

          // ── No ID — fall back to .miosa.json linked deployment ────────────
          const deploymentId = await resolveAppId(client, undefined);
          console.log(chalk.dim(`Streaming logs for ${deploymentId}...`));
          const res = await client.streamDeploymentLogs(deploymentId);
          await streamSse(res);
        } catch (err) {
          handleError(err);
        }
      },
    );
}
