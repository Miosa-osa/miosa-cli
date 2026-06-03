import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, isJsonMode, printJson } from "./util.js";

interface SandboxTemplate {
  id: string;
  name: string;
  state?: string;
  status?: string;
  image?: string;
  image_id?: string;
  dockerfile?: string;
  created_at?: string;
  inserted_at?: string;
  updated_at?: string;
}

interface TemplateBuild {
  id: string;
  template_id?: string;
  state?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
  image_digest?: string;
}

function unwrapTemplates(
  raw:
    | { data?: SandboxTemplate[]; templates?: SandboxTemplate[] }
    | SandboxTemplate[],
): SandboxTemplate[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.templates ?? [];
}

function unwrapTemplate(
  raw: { data?: SandboxTemplate; template?: SandboxTemplate } | SandboxTemplate,
): SandboxTemplate {
  if ("data" in raw && raw.data) return raw.data;
  if ("template" in raw && raw.template) return raw.template;
  return raw as SandboxTemplate;
}

function unwrapBuilds(
  raw: { data?: TemplateBuild[]; builds?: TemplateBuild[] } | TemplateBuild[],
): TemplateBuild[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.builds ?? [];
}

function fmtTemplateState(state: string | undefined): string {
  if (!state) return chalk.dim("-");
  if (state === "ready" || state === "active") return chalk.green(state);
  if (state === "building" || state === "pending") return chalk.yellow(state);
  if (state === "failed" || state === "error") return chalk.red(state);
  return chalk.dim(state);
}

function templateState(template: SandboxTemplate): string | undefined {
  return template.state ?? template.status;
}

function templateImage(template: SandboxTemplate): string | undefined {
  return template.image ?? template.image_id;
}

function templateCreatedAt(template: SandboxTemplate): string | undefined {
  return template.created_at ?? template.inserted_at;
}

function fmtBuildState(state: string | undefined): string {
  if (!state) return chalk.dim("-");
  if (state === "success" || state === "complete") return chalk.green(state);
  if (state === "building" || state === "running" || state === "pending")
    return chalk.yellow(state);
  if (state === "failed" || state === "error") return chalk.red(state);
  return chalk.dim(state);
}

export function register(program: Command): void {
  const templates = program
    .command("templates")
    .description("Manage sandbox templates");

  // list
  templates
    .command("list")
    .description("List sandbox templates")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching templates...");
        const rows = unwrapTemplates(
          await client.apiGet("/api/v1/sandbox-templates"),
        );
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No templates found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (t) => t.id.slice(0, 12), width: 14 },
          { header: "NAME", key: "name", width: 28 },
          {
            header: "STATE",
            key: (t) => fmtTemplateState(templateState(t)),
            width: 12,
          },
          {
            header: "IMAGE",
            key: (t) => {
              const image = templateImage(t);
              return image
                ? image.length > 32
                  ? `${image.slice(0, 29)}...`
                  : image
                : chalk.dim("-");
            },
            width: 34,
          },
          {
            header: "CREATED",
            key: (t) => {
              const createdAt = templateCreatedAt(t);
              return createdAt ? createdAt.slice(0, 10) : chalk.dim("-");
            },
            width: 12,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // get
  templates
    .command("get <id>")
    .description("Get sandbox template details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching template...");
        const tmpl = unwrapTemplate(
          await client.apiGet(
            `/api/v1/sandbox-templates/${encodeURIComponent(id)}`,
          ),
        );
        spinner?.stop();

        if (json) {
          printJson(tmpl);
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}       ${tmpl.id}`);
        console.log(`  ${chalk.bold("Name")}     ${tmpl.name}`);
        console.log(
          `  ${chalk.bold("State")}    ${fmtTemplateState(templateState(tmpl))}`,
        );
        const image = templateImage(tmpl);
        if (image) console.log(`  ${chalk.bold("Image")}    ${image}`);
        const createdAt = templateCreatedAt(tmpl);
        if (createdAt) console.log(`  ${chalk.bold("Created")}  ${createdAt}`);
        if (tmpl.updated_at)
          console.log(`  ${chalk.bold("Updated")}  ${tmpl.updated_at}`);
        console.log();
        console.log(
          chalk.dim(
            `  Run "miosa templates builds ${tmpl.id}" to view build history.`,
          ),
        );
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  // create
  templates
    .command("create")
    .description("Create a sandbox template from a Dockerfile")
    .requiredOption("--name <name>", "Template name")
    .requiredOption(
      "--dockerfile <path>",
      "Path to Dockerfile to build the template from",
    )
    .option("--json", "Output raw JSON")
    .action(
      async (opts: { name: string; dockerfile: string; json?: boolean }) => {
        try {
          let dockerfileContent: string;
          try {
            dockerfileContent = readFileSync(opts.dockerfile, "utf8");
          } catch (err) {
            console.error(
              chalk.red(
                `Cannot read Dockerfile at ${opts.dockerfile}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            process.exit(1);
          }

          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin(`Creating template ${opts.name}...`);
          const tmpl = unwrapTemplate(
            await client.apiPost("/api/v1/sandbox-templates", {
              name: opts.name,
              dockerfile: dockerfileContent,
            }),
          );
          spinner.succeed(`Created template ${tmpl.name}`);

          if (opts.json) {
            console.log(JSON.stringify(tmpl, null, 2));
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("ID")}     ${tmpl.id}`);
          console.log(`  ${chalk.bold("Name")}   ${tmpl.name}`);
          console.log(
            `  ${chalk.bold("State")}  ${fmtTemplateState(tmpl.state)}`,
          );
          console.log();
          console.log(
            chalk.dim(
              `  Run "miosa templates builds ${tmpl.id}" to track the build.`,
            ),
          );
          console.log();
        } catch (err) {
          handleError(err);
        }
      },
    );

  // builds
  templates
    .command("builds <id>")
    .description("List builds for a sandbox template")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching builds...");
        const rows = unwrapBuilds(
          await client.apiGet(
            `/api/v1/sandbox-templates/${encodeURIComponent(id)}/builds`,
          ),
        );
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No builds found."));
          return;
        }

        renderTable(rows, [
          { header: "BUILD ID", key: (b) => b.id.slice(0, 12), width: 14 },
          {
            header: "STATE",
            key: (b) => fmtBuildState(b.state),
            width: 12,
          },
          {
            header: "STARTED",
            key: (b) =>
              b.started_at
                ? b.started_at.slice(0, 19).replace("T", " ")
                : chalk.dim("-"),
            width: 20,
          },
          {
            header: "FINISHED",
            key: (b) =>
              b.finished_at
                ? b.finished_at.slice(0, 19).replace("T", " ")
                : chalk.dim("-"),
            width: 20,
          },
          {
            header: "ERROR",
            key: (b) =>
              b.error
                ? chalk.red(
                    b.error.length > 30
                      ? `${b.error.slice(0, 27)}...`
                      : b.error,
                  )
                : chalk.dim("-"),
            width: 32,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // delete
  templates
    .command("delete <id>")
    .description("Delete a sandbox template")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
      try {
        if (!opts.force) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: chalk.red(
                `Delete template ${id}? This will remove the template and its build history.`,
              ),
              default: false,
            },
          ]);
          if (!ok) {
            console.log(chalk.dim("  Cancelled."));
            process.exit(0);
          }
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Deleting template...");
        const result = await client.apiDelete(
          `/api/v1/sandbox-templates/${encodeURIComponent(id)}`,
        );
        spinner.succeed("Template deleted");
        if (opts.json)
          console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });
}
