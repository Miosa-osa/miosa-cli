import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient, parseSse } from "../client.js";
import { spin } from "../ui/spinner.js";
import { renderTable } from "../ui/table.js";
import { handleError } from "./util.js";
import { resolveDeploymentId } from "./project.js";
import type { BuildId, DeploymentBuild } from "../types.js";

// ── helpers ───────────────────────────────────────────────────────────────────

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

function printBuild(build: DeploymentBuild): void {
  console.log();
  console.log(`  ${chalk.bold("Build")}      ${build.id}`);
  console.log(`  ${chalk.bold("State")}      ${stateColor(build.state)}`);
  console.log(
    `  ${chalk.bold("Commit")}     ${build.commit_sha?.slice(0, 8) ?? chalk.dim("none")}`,
  );
  if (build.commit_message) {
    console.log(`  ${chalk.bold("Message")}    ${build.commit_message}`);
  }
  console.log(`  ${chalk.bold("Triggered")}  ${build.triggered_by}`);
  if (build.started_at) {
    console.log(`  ${chalk.bold("Started")}    ${build.started_at}`);
  }
  if (build.finished_at) {
    console.log(`  ${chalk.bold("Finished")}   ${build.finished_at}`);
  }
  if (build.duration_ms !== null) {
    console.log(
      `  ${chalk.bold("Duration")}   ${(build.duration_ms / 1000).toFixed(1)}s`,
    );
  }
  if (build.error_message) {
    console.log(
      `  ${chalk.bold("Error")}      ${chalk.red(build.error_message)}`,
    );
  }
  console.log();
}

// ── register ──────────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const builds = program
    .command("builds")
    .description("Inspect build history for a deployment")
    .addHelpText(
      "after",
      `
Examples:
  miosa builds list <deployment-id>
  miosa builds get <deployment-id> <build-id>
  miosa builds logs <deployment-id> <build-id>
`,
    );

  // ── builds list ─────────────────────────────────────────────────────────────

  builds
    .command("list <deployment-id>")
    .description("List builds for a deployment")
    .option("--json", "Output as JSON")
    .action(async (deploymentId: string, opts: { json?: boolean }) => {
      try {
        const client = new MiosaClient(loadConfig());
        const id = resolveDeploymentId(deploymentId);
        const spinner = spin("Fetching builds...");
        const rows = await client.listBuilds(id);
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("  No builds found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (r) => shortId(r.id), width: 10 },
          { header: "STATE", key: (r) => stateColor(r.state), width: 12 },
          {
            header: "COMMIT",
            key: (r) => r.commit_sha?.slice(0, 8) ?? chalk.dim("none"),
            width: 10,
          },
          {
            header: "MESSAGE",
            key: (r) => r.commit_message ?? chalk.dim("none"),
            width: 36,
          },
          {
            header: "DURATION",
            key: (r) =>
              r.duration_ms !== null
                ? `${(r.duration_ms / 1000).toFixed(1)}s`
                : chalk.dim("-"),
            width: 10,
          },
          { header: "CREATED", key: "created_at", width: 22 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // ── builds get ──────────────────────────────────────────────────────────────

  builds
    .command("get <deployment-id> <build-id>")
    .description("Show details for a single build")
    .option("--json", "Output as JSON")
    .action(
      async (
        deploymentId: string,
        buildId: string,
        opts: { json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);
          const spinner = spin("Fetching build...");
          const build = await client.getBuild(id, buildId as BuildId);
          spinner.stop();

          if (opts.json) {
            console.log(JSON.stringify(build, null, 2));
            return;
          }

          printBuild(build);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── builds logs ─────────────────────────────────────────────────────────────

  builds
    .command("logs <deployment-id> <build-id>")
    .description("Stream logs for a specific build (SSE)")
    .option("--json", "Output raw JSON log lines")
    .action(
      async (
        deploymentId: string,
        buildId: string,
        opts: { json?: boolean },
      ) => {
        try {
          const client = new MiosaClient(loadConfig());
          const id = resolveDeploymentId(deploymentId);

          console.log(
            chalk.dim(`  Streaming logs for build ${shortId(buildId)}...`),
          );
          console.log(chalk.dim("  " + "─".repeat(60)));

          const streamRes = await client.streamBuildLogs(
            id,
            buildId as BuildId,
          );

          for await (const event of parseSse(streamRes.body)) {
            switch (event.type) {
              case "stdout":
                if (opts.json) {
                  console.log(
                    JSON.stringify({ stream: "stdout", line: event.data }),
                  );
                } else {
                  process.stdout.write(chalk.dim("  ") + event.data);
                }
                break;
              case "stderr":
                if (opts.json) {
                  console.log(
                    JSON.stringify({ stream: "stderr", line: event.data }),
                  );
                } else {
                  process.stderr.write(chalk.red("  ") + event.data);
                }
                break;
              case "error":
                console.error(chalk.red(`  [error] ${event.message}`));
                break;
              case "done":
                console.log(chalk.dim("  " + "─".repeat(60)));
                return;
              case "unknown":
                try {
                  const parsed = JSON.parse(event.raw) as Record<
                    string,
                    unknown
                  >;
                  if (typeof parsed["line"] === "string") {
                    const line = parsed["line"];
                    if (opts.json) {
                      console.log(
                        JSON.stringify({
                          stream: parsed["stream"] ?? "stdout",
                          line,
                        }),
                      );
                    } else if (parsed["stream"] === "stderr") {
                      process.stderr.write(chalk.red("  ") + line + "\n");
                    } else {
                      process.stdout.write(chalk.dim("  ") + line + "\n");
                    }
                  }
                } catch {
                  // ignore unparseable frames
                }
                break;
              default:
                break;
            }
          }

          console.log(chalk.dim("  " + "─".repeat(60)));
        } catch (err) {
          handleError(err);
        }
      },
    );
}
