import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { UserError } from "../errors.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import type { Deployment } from "../types.js";

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

function printMachineLogs(payload: unknown): void {
  if (Array.isArray(payload)) {
    for (const row of payload) console.log(JSON.stringify(row));
    return;
  }
  if (payload && typeof payload === "object" && "data" in payload) {
    printMachineLogs((payload as { data: unknown }).data);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

export function register(program: Command): void {
  program
    .command("logs [app]")
    .description("Stream app logs or fetch machine logs")
    .option("--machine <id>", "Fetch logs for a machine/computer")
    .option("--json", "Output raw JSON for machine log snapshots")
    .action(
      async (
        app: string | undefined,
        opts: { machine?: string; json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());

          if (opts.machine) {
            const payload = await client.apiGet<unknown>(
              `/api/v1/computers/${encodeURIComponent(opts.machine)}/logs`,
            );
            if (opts.json) console.log(JSON.stringify(payload, null, 2));
            else printMachineLogs(payload);
            return;
          }

          const deploymentId = await resolveAppId(client, app);
          console.log(chalk.dim(`Streaming logs for ${deploymentId}...`));
          const res = await client.streamDeploymentLogs(deploymentId);

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
        } catch (err) {
          handleError(err);
        }
      },
    );
}
