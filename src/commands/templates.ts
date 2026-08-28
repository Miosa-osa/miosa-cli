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

interface ProductTemplate {
  id: string;
  name: string;
  product: string;
  default_size?: string;
  image_id?: string;
  readiness?: string;
  sizes?: Array<{
    size: string;
    state?: string;
    resource_contract?: {
      contract_id?: string;
      vcpus?: number;
      memory_mb?: number;
      disk_size_mb?: number;
    };
  }>;
}

function productTemplates(raw: Record<string, unknown>): ProductTemplate[] {
  const rows = Array.isArray(raw["data"])
    ? raw["data"]
    : Array.isArray(raw["templates"])
      ? raw["templates"]
      : [];
  return rows as ProductTemplate[];
}

interface TemplateVersion {
  version: number;
  ref?: string;
  build_id?: string;
  state?: string;
  image_id?: string | null;
  usable?: boolean;
  current?: boolean;
  created_at?: string;
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

/**
 * Whether a template's IMAGE is confirmed to exist.
 *
 * Ross/HackerAI asked for this outright: `templates list` must distinguish
 * confirmed-absent from confirmed-present from cannot-verify. Collapsing the
 * three is how a customer concludes "my template is gone" from a listing that
 * merely failed to check.
 */
type Presence = "present" | "absent" | "unknown";

function templatePresence(template: SandboxTemplate): {
  presence: Presence;
  why: string;
} {
  const state = templateState(template);
  const image = templateImage(template);

  if (image) {
    return { presence: "present", why: `image ${image} is recorded on the template` };
  }
  // A draft or failed build has no image BY DEFINITION - that is a confirmed
  // absence, not a gap in our knowledge.
  if (state === "draft" || state === "failed" || state === "error") {
    return { presence: "absent", why: `template is ${state}, so no image was ever published` };
  }
  if (state === "building" || state === "pending" || state === "queued") {
    return { presence: "absent", why: `build is ${state}, no image published yet` };
  }
  // Ready, but no image recorded. We genuinely cannot tell.
  return {
    presence: "unknown",
    why: `template reports ${state ?? "no state"} but records no image - cannot confirm either way`,
  };
}

function fmtPresence(p: Presence): string {
  if (p === "present") return chalk.green("present");
  if (p === "absent") return chalk.yellow("absent");
  return chalk.dim("unverified");
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

  templates
    .command("catalog")
    .description(
      "List canonical product templates, image generations, shapes, and readiness",
    )
    .option("--product <product>", "Filter by product, for example sandbox")
    .option("--json", "Output the complete catalog as JSON")
    .action(async (opts: { product?: string; json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const raw = await client.apiGet<Record<string, unknown>>(
          "/api/v1/templates",
        );
        const rows = productTemplates(raw);
        const filtered = opts.product
          ? rows.filter((template) => template.product === opts.product)
          : rows;

        if (isJsonMode(opts)) {
          printJson(opts.product ? { ...raw, templates: filtered } : raw);
          return;
        }

        renderTable(filtered, [
          { header: "ID", key: "id", width: 28 },
          { header: "PRODUCT", key: "product", width: 18 },
          { header: "DEFAULT", key: (t) => t.default_size ?? "-", width: 10 },
          {
            header: "IMAGE GENERATION",
            key: (t) => t.image_id ?? "-",
            width: 32,
          },
          {
            header: "READINESS",
            key: (t) => t.readiness ?? "missing",
            width: 18,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  templates
    .command("readiness <id>")
    .description(
      "Show fleet readiness and exact resource contracts for a product template",
    )
    .option("--product <product>", "Filter by product, for example sandbox")
    .option("--json", "Output raw readiness rows")
    .action(async (id: string, opts: { product?: string; json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const raw = await client.apiGet<Record<string, unknown>>(
          "/api/v1/templates",
        );
        const rows = productTemplates(raw);
        const template = rows.find(
          (candidate) =>
            candidate.id === id && (!opts.product || candidate.product === opts.product),
        );
        if (!template) throw new Error(`Product template not found: ${id}`);
        const readiness = template.sizes ?? [];

        if (isJsonMode(opts)) {
          printJson(readiness);
          return;
        }

        renderTable(readiness, [
          { header: "SIZE", key: "size", width: 10 },
          { header: "STATE", key: (row) => row.state ?? "missing", width: 18 },
          {
            header: "VCPU",
            key: (row) => String(row.resource_contract?.vcpus ?? "-"),
            width: 8,
          },
          {
            header: "MEMORY MIB",
            key: (row) => String(row.resource_contract?.memory_mb ?? "-"),
            width: 12,
          },
          {
            header: "DISK MIB",
            key: (row) => String(row.resource_contract?.disk_size_mb ?? "-"),
            width: 12,
          },
          {
            header: "CONTRACT",
            key: (row) => row.resource_contract?.contract_id ?? "-",
            width: 26,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // list
  templates
    .command("list")
    .description(
      "List sandbox templates, distinguishing confirmed-absent from cannot-verify",
    )
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const client = new MiosaClient(config);
      const json = isJsonMode(opts);
      const spinner = json ? null : spin("Fetching templates...");
      const checkedAt = new Date().toISOString();

      let rows: SandboxTemplate[];
      try {
        rows = unwrapTemplates(await client.apiGet("/api/v1/sandbox-templates"));
      } catch (err) {
        // The listing could NOT be verified. This is emphatically not "no
        // templates" - reporting an empty list here would tell a customer their
        // templates are gone when we simply failed to ask.
        spinner?.stop();
        const reason = err instanceof Error ? err.message : String(err);
        if (json) {
          printJson({
            listing: {
              state: "unverified",
              source: "live",
              checkedAt,
              reason,
            },
            templates: null,
          });
        } else {
          console.log();
          console.log(
            `  ${chalk.yellow("Cannot verify")} - the template list could not be retrieved.`,
          );
          console.log(`  ${chalk.dim(reason)}`);
          console.log(
            `  ${chalk.dim("This is NOT the same as having no templates. Run: miosa doctor")}`,
          );
        }
        // Non-zero: a script must be able to tell an unverified listing from an
        // empty one.
        process.exitCode = 1;
        return;
      }
      spinner?.stop();

      try {
        if (json) {
          printJson({
            // Never presented as current without saying when it was checked,
            // and never cached: this is a live read every time.
            listing: {
              state: "confirmed",
              source: "live",
              checkedAt,
              count: rows.length,
            },
            templates: rows.map((t) => {
              const { presence, why } = templatePresence(t);
              return { ...t, presence, presenceReason: why };
            }),
          });
          return;
        }

        if (rows.length === 0) {
          console.log(
            chalk.dim(
              `No templates. Confirmed empty by a live read at ${checkedAt}.`,
            ),
          );
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
            key: (t) => fmtPresence(templatePresence(t).presence),
            width: 12,
          },
          {
            header: "IMAGE ID",
            key: (t) => {
              const image = templateImage(t);
              return image
                ? image.length > 26
                  ? `${image.slice(0, 23)}...`
                  : image
                : chalk.dim("-");
            },
            width: 28,
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

        const unverified = rows.filter(
          (t) => templatePresence(t).presence === "unknown",
        );
        if (unverified.length > 0) {
          console.log();
          console.log(
            chalk.dim(
              `  ${unverified.length} template(s) report no image and could not be confirmed either way.`,
            ),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  // versions
  templates
    .command("versions <id>")
    .description(
      "List a template's versions (a version is a build; specs are immutable)",
    )
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching versions...");
        const raw = (await client.apiGet(
          `/api/v1/sandbox-templates/${encodeURIComponent(id)}/versions`,
        )) as { data?: TemplateVersion[] } | TemplateVersion[];
        spinner?.stop();

        const rows: TemplateVersion[] = Array.isArray(raw) ? raw : (raw.data ?? []);

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No versions yet."));
          return;
        }

        renderTable(rows, [
          {
            header: "VERSION",
            key: (v) => (v.current ? chalk.bold(`v${v.version} *`) : `v${v.version}`),
            width: 10,
          },
          { header: "REF", key: (v) => v.ref ?? chalk.dim("-"), width: 26 },
          {
            header: "STATE",
            key: (v) => fmtBuildState(v.state),
            width: 12,
          },
          {
            // Whether this version can actually be run or migrated to. A failed
            // build is listed - you need to see it to understand why the next
            // version is unavailable - but it is not usable.
            header: "USABLE",
            key: (v) => (v.usable ? chalk.green("yes") : chalk.dim("no")),
            width: 8,
          },
          {
            header: "IMAGE",
            key: (v) => v.image_id ?? chalk.dim("-"),
            width: 26,
          },
          {
            header: "CREATED",
            key: (v) => (v.created_at ? String(v.created_at).slice(0, 10) : chalk.dim("-")),
            width: 12,
          },
        ]);

        console.log();
        console.log(
          chalk.dim(
            "  * = current. Specs are immutable: editing a template mints a new version,",
          ),
        );
        console.log(
          chalk.dim(
            "  and existing sandboxes keep running the version they were created from.",
          ),
        );
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
