import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError, isJsonMode, printJson } from "./util.js";
import { ApiResponseError, UserError } from "../errors.js";

/**
 * Custom sandbox template as the API renders it.
 *
 * Two endpoints return different subsets of the same row, which is why so many
 * fields are optional:
 *
 *   GET /api/v1/sandbox-templates      the catalog. Built-ins and the tenant's
 *                                      own rows are both passed through
 *                                      `Templates.render_for_catalog/1`, whose
 *                                      `Map.take/2` keeps a fixed atom list and
 *                                      therefore DROPS `slug`, `inserted_at`,
 *                                      `updated_at` and `current_build_id` from
 *                                      a custom row.
 *   GET /api/v1/sandbox-templates/:id  the full `render_template/1` map,
 *                                      including everything the catalog drops.
 */
interface SandboxTemplate {
  id: string;
  name: string;
  /** The identifier `POST /api/v1/sandboxes` accepts. Absent in catalog rows. */
  slug?: string;
  /** Custom rows report `status`; built-ins report `status` too. */
  state?: string;
  status?: string;
  /** Present only once a build has produced an image. */
  image?: string;
  image_id?: string | null;
  built_in?: boolean;
  category?: string;
  description?: string | null;
  current_build_id?: string | null;
  build_spec?: Record<string, unknown> | null;
  dockerfile?: string;
  created_at?: string;
  inserted_at?: string;
  updated_at?: string;
}

interface TemplateBuild {
  id: string;
  template_id?: string;
  sandbox_template_id?: string;
  state?: string;
  started_at?: string | null;
  finished_at?: string | null;
  /** Server field names. `error` was the only one read before, and the API
   * never sends it, so build failures showed a blank ERROR column. */
  error?: string;
  error_code?: string | null;
  error_message?: string | null;
  image_id?: string | null;
  image_digest?: string;
  duration_ms?: number | null;
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
  if (state === "building" || state === "pending" || state === "draft")
    return chalk.yellow(state);
  if (state === "failed" || state === "error") return chalk.red(state);
  return chalk.dim(state);
}

function templateState(template: SandboxTemplate): string | undefined {
  return template.state ?? template.status;
}

function templateImage(template: SandboxTemplate): string | undefined {
  return template.image ?? template.image_id ?? undefined;
}

function templateCreatedAt(template: SandboxTemplate): string | undefined {
  return template.created_at ?? template.inserted_at;
}

/** A tenant-owned template, as opposed to a platform built-in. */
function isCustom(template: SandboxTemplate): boolean {
  if (typeof template.built_in === "boolean") return !template.built_in;
  // Older payloads without `built_in`: a custom row is the only kind with a
  // UUID id and the "custom" category.
  return template.category === "custom" || isUuid(template.id);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

interface Usability {
  readonly usable: boolean;
  /** Why it is or is not usable, in one clause. */
  readonly reason: string;
}

/**
 * A definitive answer to "can I boot a sandbox from this right now?".
 *
 * A template row exists the moment `POST /api/v1/sandbox-templates` returns
 * 201, but it has no bootable image until a build reaches "ready". Reporting
 * the row's mere existence as readiness is what left the customer unable to
 * tell whether his template had been created (2026-08-26 live customer call).
 */
function usability(
  template: SandboxTemplate,
  builds?: readonly TemplateBuild[],
): Usability {
  const state = templateState(template);
  const image = templateImage(template);

  if (state === "ready" || state === "active") {
    return image
      ? { usable: true, reason: `build complete, image ${image}` }
      : {
          usable: false,
          reason: "state is ready but no image was reported - contact support",
        };
  }
  if (state === "archived") {
    return { usable: false, reason: "archived" };
  }
  if (state === "failed") {
    const failed = builds?.find((build) => build.state === "failed");
    const why = buildError(failed);
    return {
      usable: false,
      reason: why ? `last build failed: ${why}` : "last build failed",
    };
  }

  const active = builds?.find((build) =>
    [
      "queued",
      "building",
      "certifying",
      "snapshotting",
      "running",
      "pending",
    ].includes(build.state ?? ""),
  );
  if (active) {
    return {
      usable: false,
      reason: `build ${shortId(active.id)} is ${active.state} - not finished yet`,
    };
  }
  if (builds && builds.length === 0) {
    return { usable: false, reason: "no build has been started yet" };
  }
  return {
    usable: false,
    reason: `no completed build yet (state ${state ?? "unknown"})`,
  };
}

function buildError(build: TemplateBuild | undefined): string | undefined {
  if (!build) return undefined;
  const message = build.error_message ?? build.error;
  if (message && build.error_code) return `${build.error_code}: ${message}`;
  return message ?? build.error_code ?? undefined;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

function fmtBuildState(state: string | undefined): string {
  if (!state) return chalk.dim("-");
  if (state === "ready" || state === "success" || state === "complete")
    return chalk.green(state);
  if (
    state === "building" ||
    state === "running" ||
    state === "pending" ||
    state === "queued" ||
    state === "certifying" ||
    state === "snapshotting"
  )
    return chalk.yellow(state);
  if (state === "failed" || state === "error" || state === "cancelled")
    return chalk.red(state);
  return chalk.dim(state);
}

function client(): MiosaClient {
  return new MiosaClient(loadConfig());
}

function readDockerfile(path: string): string {
  try {
    const contents = readFileSync(path, "utf8");
    if (contents.trim() === "") {
      throw new UserError(
        `The Dockerfile at ${path} is empty.`,
        "A template needs at least a FROM line.",
      );
    }
    return contents;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(
      `Cannot read Dockerfile at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      "Pass --dockerfile with a path to a readable Dockerfile.",
    );
  }
}

/** Fetch the tenant's own templates, resolved to their full shape. */
async function fetchTemplate(
  api: MiosaClient,
  id: string,
): Promise<SandboxTemplate> {
  return unwrapTemplate(
    await api.apiGet(`/api/v1/sandbox-templates/${encodeURIComponent(id)}`),
  );
}

async function fetchBuilds(
  api: MiosaClient,
  id: string,
): Promise<TemplateBuild[]> {
  return unwrapBuilds(
    await api.apiGet(
      `/api/v1/sandbox-templates/${encodeURIComponent(id)}/builds`,
    ),
  );
}

/** Print the definitive existence/usability block for one custom template. */
function printTemplateDetail(
  template: SandboxTemplate,
  builds: readonly TemplateBuild[] | undefined,
  opts: { verified: boolean },
): void {
  const status = usability(template, builds);
  const reference = template.slug ?? template.id;

  console.log();
  console.log(`  ${chalk.bold("ID")}        ${template.id}`);
  console.log(`  ${chalk.bold("Name")}      ${template.name}`);
  if (template.slug)
    console.log(`  ${chalk.bold("Slug")}      ${template.slug}`);
  console.log(
    `  ${chalk.bold("State")}     ${fmtTemplateState(templateState(template))}`,
  );
  console.log(
    `  ${chalk.bold("Exists")}    ${
      opts.verified
        ? chalk.green("yes (confirmed by a follow-up read)")
        : chalk.green("yes")
    }`,
  );
  console.log(
    `  ${chalk.bold("Usable")}    ${
      status.usable
        ? chalk.green(`yes - ${status.reason}`)
        : chalk.yellow(`no - ${status.reason}`)
    }`,
  );
  const image = templateImage(template);
  console.log(`  ${chalk.bold("Image")}     ${image ?? chalk.dim("none yet")}`);
  if (builds) {
    console.log(
      `  ${chalk.bold("Builds")}    ${
        builds.length === 0
          ? chalk.dim("none")
          : `${builds.length} (latest ${shortId(builds[0]?.id ?? "")} ${builds[0]?.state ?? "unknown"})`
      }`,
    );
    const failure = buildError(
      builds.find((build) => build.state === "failed"),
    );
    if (failure)
      console.log(`  ${chalk.bold("Failure")}   ${chalk.red(failure)}`);
  }
  const createdAt = templateCreatedAt(template);
  if (createdAt) console.log(`  ${chalk.bold("Created")}   ${createdAt}`);
  if (template.updated_at)
    console.log(`  ${chalk.bold("Updated")}   ${template.updated_at}`);
  console.log();

  if (status.usable) {
    console.log(
      chalk.dim(`  Boot it:   miosa sandbox create --template ${reference}`),
    );
  } else {
    console.log(
      chalk.yellow(
        `  Not bootable yet. "miosa sandbox create --template ${reference}" will fail until a build reaches "ready".`,
      ),
    );
  }
  console.log(chalk.dim(`  Builds:    miosa templates builds ${template.id}`));
  console.log(chalk.dim(`  Re-verify: miosa templates get ${reference}`));
  console.log();
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
        const raw =
          await client().apiGet<Record<string, unknown>>("/api/v1/templates");
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
        handleError(err, opts);
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
        const raw =
          await client().apiGet<Record<string, unknown>>("/api/v1/templates");
        const rows = productTemplates(raw);
        const template = rows.find(
          (candidate) =>
            candidate.id === id &&
            (!opts.product || candidate.product === opts.product),
        );
        if (!template) throw new UserError(`Product template not found: ${id}`);
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
        handleError(err, opts);
      }
    });

  // list
  templates
    .command("list")
    .description(
      "List sandbox templates. Your own templates are listed first and marked yours.",
    )
    .option("--mine", "Show only templates this workspace created")
    .option("--built-in", "Show only platform built-in templates")
    .option(
      "--verify",
      "Read each of your templates back individually to confirm it exists and fill in the slug and created date the catalog omits",
    )
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        mine?: boolean;
        builtIn?: boolean;
        verify?: boolean;
        json?: boolean;
      }) => {
        try {
          const api = client();
          const json = isJsonMode(opts);
          const spinner = json ? null : spin("Fetching templates...");
          let rows: SandboxTemplate[];
          try {
            rows = unwrapTemplates(
              await api.apiGet("/api/v1/sandbox-templates"),
            );
          } catch (err) {
            spinner?.fail("Could not fetch templates");
            throw err;
          }

          let mine = rows.filter(isCustom);
          const platform = rows.filter((row) => !isCustom(row));

          if (opts.verify && mine.length > 0) {
            spinner?.stop();
            // The catalog rendering drops `slug` and `inserted_at` from custom
            // rows, so the only way to report them is a per-row read. This also
            // proves each row is individually retrievable, not just present in
            // an aggregate list.
            mine = await Promise.all(
              mine.map(async (row) => {
                try {
                  return await fetchTemplate(api, row.id);
                } catch {
                  return row;
                }
              }),
            );
          }
          spinner?.stop();

          const selected = opts.mine
            ? mine
            : opts.builtIn
              ? platform
              : [...mine, ...platform];

          if (json) {
            printJson(selected);
            return;
          }

          if (selected.length === 0) {
            if (opts.mine) {
              console.log(
                chalk.dim(
                  "This workspace has not created any sandbox templates.",
                ),
              );
              console.log(
                chalk.dim(
                  "  Create one: miosa templates create --name my-template --dockerfile ./Dockerfile",
                ),
              );
            } else {
              console.log(chalk.dim("No templates found."));
            }
            return;
          }

          // The slug is what `sandbox create --template` accepts, and the
          // catalog omits it for custom rows, so only offer the column when a
          // value is actually known.
          const anySlug = selected.some((row) => Boolean(row.slug));

          renderTable(selected, [
            {
              header: "SOURCE",
              key: (t) =>
                isCustom(t) ? chalk.cyan("yours") : chalk.dim("built-in"),
              width: 10,
            },
            { header: "ID", key: (t) => t.id, width: 38 },
            ...(anySlug
              ? [
                  {
                    header: "TEMPLATE REF",
                    key: (t: SandboxTemplate) =>
                      t.slug ?? (isCustom(t) ? chalk.dim("-") : t.id),
                    width: 24,
                  },
                ]
              : []),
            { header: "NAME", key: "name", width: 26 },
            {
              header: "STATE",
              key: (t) => fmtTemplateState(templateState(t)),
              width: 10,
            },
            {
              header: "USABLE",
              key: (t) =>
                usability(t).usable ? chalk.green("yes") : chalk.yellow("no"),
              width: 8,
            },
            {
              header: "IMAGE",
              key: (t) => {
                const image = templateImage(t);
                return image
                  ? image.length > 28
                    ? `${image.slice(0, 25)}...`
                    : image
                  : chalk.dim("-");
              },
              width: 30,
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

          console.log();
          if (mine.length === 0) {
            console.log(
              chalk.yellow(
                "  None of these are yours - this workspace has not created any templates.",
              ),
            );
            console.log(
              chalk.dim(
                "  Create one: miosa templates create --name my-template --dockerfile ./Dockerfile",
              ),
            );
          } else {
            console.log(
              opts.mine
                ? chalk.dim(
                    `  ${mine.length} template${mine.length === 1 ? "" : "s"} created by this workspace. Platform built-ins are hidden; drop --mine to see them.`,
                  )
                : chalk.dim(
                    `  ${mine.length} of these ${mine.length === 1 ? "is" : "are"} yours (SOURCE=yours); the other ${platform.length} are platform built-ins.`,
                  ),
            );
            if (!opts.mine) {
              console.log(
                chalk.dim("  Only yours: miosa templates list --mine"),
              );
            }
            if (!opts.verify) {
              console.log(
                chalk.dim(
                  "  The catalog omits the slug and created date of your own rows; add --verify to read them back individually.",
                ),
              );
            }
          }
          console.log();
        } catch (err) {
          handleError(err, opts);
        }
      },
    );

  // get
  templates
    .command("get <id>")
    .description("Get sandbox template details, including whether it is usable")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const api = client();
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching template...");
        let template: SandboxTemplate;
        try {
          template = await fetchTemplate(api, id);
        } catch (err) {
          spinner?.fail(`Template not found: ${id}`);
          throw err;
        }

        // Builds are what decide usability, and the read is scoped to the same
        // template, so fetch them rather than guessing from `status` alone.
        // Built-ins have no build history endpoint of their own.
        const builds = isCustom(template)
          ? await fetchBuilds(api, template.id).catch(() => undefined)
          : undefined;
        spinner?.stop();

        if (json) {
          printJson({
            ...template,
            usable: usability(template, builds).usable,
            usable_reason: usability(template, builds).reason,
            ...(builds ? { builds } : {}),
          });
          return;
        }

        printTemplateDetail(template, builds, { verified: false });
      } catch (err) {
        handleError(err, opts);
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
    .option("--description <text>", "Human description of the template")
    .option(
      "--no-verify",
      "Skip the follow-up read that confirms the template exists",
    )
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        name: string;
        dockerfile: string;
        description?: string;
        verify: boolean;
        json?: boolean;
      }) => {
        const json = isJsonMode(opts);
        try {
          const dockerfile = readDockerfile(opts.dockerfile);
          const api = client();
          const spinner = json
            ? null
            : spin(`Creating template ${opts.name}...`);
          let template: SandboxTemplate;
          try {
            template = unwrapTemplate(
              await api.apiPost("/api/v1/sandbox-templates", {
                name: opts.name,
                dockerfile,
                ...(opts.description ? { description: opts.description } : {}),
              }),
            );
          } catch (err) {
            // Leaving the spinner spinning under an error message was how the
            // customer's failed create looked like a hung command.
            spinner?.fail(`Could not create template ${opts.name}`);
            throw err;
          }
          spinner?.succeed(`Created template ${template.name}`);

          // The create response is rendered from the in-memory row, so its
          // `current_build_id` is still null even though the controller has
          // already enqueued the initial build. Read the row and its builds
          // back to give a definitive answer instead of an optimistic one.
          let verified = false;
          let builds: TemplateBuild[] | undefined;
          if (opts.verify) {
            try {
              template = await fetchTemplate(api, template.id);
              verified = true;
            } catch {
              verified = false;
            }
            builds = await fetchBuilds(api, template.id).catch(() => undefined);
          }

          if (json) {
            printJson({
              ...template,
              verified,
              usable: usability(template, builds).usable,
              usable_reason: usability(template, builds).reason,
              ...(builds ? { builds } : {}),
            });
            return;
          }

          printTemplateDetail(template, builds, { verified });
          if (opts.verify && !verified) {
            console.log(
              chalk.yellow(
                "  Warning: the create call returned 201 but the follow-up read did not find this template.",
              ),
            );
            console.log(
              chalk.dim(
                `  Check again: miosa templates get ${template.id}   (or: miosa templates list --mine)`,
              ),
            );
            console.log();
          }
        } catch (err) {
          handleError(err, opts);
        }
      },
    );

  // update
  templates
    .command("update <id>")
    .description(
      "Update a template's Dockerfile. Replaces the spec in place while it has no usable build; otherwise starts a new build from the new Dockerfile.",
    )
    .requiredOption("--dockerfile <path>", "Path to the new Dockerfile")
    .option("--description <text>", "Replace the description")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        opts: { dockerfile: string; description?: string; json?: boolean },
      ) => {
        const json = isJsonMode(opts);
        try {
          const dockerfile = readDockerfile(opts.dockerfile);
          const api = client();
          const spinner = json ? null : spin(`Reading template ${id}...`);

          let existing: SandboxTemplate;
          try {
            existing = await fetchTemplate(api, id);
          } catch (err) {
            spinner?.fail(`Template not found: ${id}`);
            throw err;
          }
          if (!isCustom(existing)) {
            spinner?.fail(`${existing.name} is a platform built-in`);
            throw new UserError(
              `${existing.id} is a platform built-in template and cannot be updated.`,
              "Create your own template instead: miosa templates create --name <name> --dockerfile ./Dockerfile",
            );
          }

          const state = templateState(existing);
          // The API has two update mechanisms and which one applies depends on
          // whether the row already owns a usable image:
          //
          //   draft / failed -> POST /api/v1/sandbox-templates upserts the row
          //     in place for the same tenant+slug, replacing build_spec and
          //     clearing image_id/current_build_id.
          //   ready / building / archived -> that upsert is a real uniqueness
          //     collision, so the supported path is a new build from the new
          //     spec: POST /api/v1/sandbox-templates/:id/builds.
          const replaceInPlace = state === "draft" || state === "failed";

          let template: SandboxTemplate;
          let build: TemplateBuild | undefined;
          if (replaceInPlace) {
            spinner?.start(`Replacing the spec of ${existing.name}...`);
            try {
              template = unwrapTemplate(
                await api.apiPost("/api/v1/sandbox-templates", {
                  name: existing.name,
                  ...(existing.slug ? { slug: existing.slug } : {}),
                  dockerfile,
                  ...(opts.description !== undefined
                    ? { description: opts.description }
                    : existing.description
                      ? { description: existing.description }
                      : {}),
                }),
              );
            } catch (err) {
              spinner?.fail(`Could not update ${existing.name}`);
              throw err;
            }
            spinner?.succeed(
              `Replaced the spec of ${template.name} in place (it had no usable build)`,
            );
          } else {
            spinner?.start(`Starting a new build of ${existing.name}...`);
            try {
              const raw = await api.apiPost<{ data?: TemplateBuild }>(
                `/api/v1/sandbox-templates/${encodeURIComponent(existing.id)}/builds`,
                { dockerfile },
              );
              build = raw.data ?? (raw as TemplateBuild);
            } catch (err) {
              spinner?.fail(`Could not start a new build of ${existing.name}`);
              throw err;
            }
            spinner?.succeed(
              `Started build ${shortId(build.id)} of ${existing.name} from the new Dockerfile`,
            );
            template = await fetchTemplate(api, existing.id).catch(
              () => existing,
            );
          }

          const builds = await fetchBuilds(api, template.id).catch(
            () => undefined,
          );

          if (json) {
            printJson({
              ...template,
              mechanism: replaceInPlace ? "spec_replaced" : "new_build",
              ...(build ? { build } : {}),
              usable: usability(template, builds).usable,
              usable_reason: usability(template, builds).reason,
              ...(builds ? { builds } : {}),
            });
            return;
          }

          // Which of the two mechanisms ran is the one thing a caller must not
          // have to guess, so state it on stdout rather than only in the
          // spinner line (which ora writes to stderr and which is lost the
          // moment output is redirected).
          console.log();
          console.log(
            replaceInPlace
              ? chalk.dim(
                  `  ${existing.name} had no usable build, so its stored Dockerfile was replaced in place\n  and a fresh build was queued. Same template ID, same name.`,
                )
              : chalk.dim(
                  `  ${existing.name} already had a usable image, so its stored spec was not overwritten;\n  the new Dockerfile is building as a new build instead.`,
                ),
          );
          printTemplateDetail(template, builds, { verified: true });
        } catch (err) {
          handleError(err, opts);
        }
      },
    );

  // rebuild
  templates
    .command("rebuild <id>")
    .description(
      "Start a new build of an existing template, optionally from a new Dockerfile",
    )
    .option(
      "--dockerfile <path>",
      "Build from this Dockerfile instead of the template's stored spec",
    )
    .option("--json", "Output raw JSON")
    .action(
      async (id: string, opts: { dockerfile?: string; json?: boolean }) => {
        const json = isJsonMode(opts);
        try {
          const api = client();
          const body = opts.dockerfile
            ? { dockerfile: readDockerfile(opts.dockerfile) }
            : {};
          const spinner = json ? null : spin(`Starting a build of ${id}...`);
          let build: TemplateBuild;
          try {
            const raw = await api.apiPost<{ data?: TemplateBuild }>(
              `/api/v1/sandbox-templates/${encodeURIComponent(id)}/builds`,
              body,
            );
            build = raw.data ?? (raw as TemplateBuild);
          } catch (err) {
            spinner?.fail(`Could not start a build of ${id}`);
            throw err;
          }
          spinner?.succeed(`Started build ${shortId(build.id)}`);

          if (json) {
            printJson(build);
            return;
          }

          console.log();
          console.log(`  ${chalk.bold("Build")}  ${build.id}`);
          console.log(
            `  ${chalk.bold("State")}  ${fmtBuildState(build.state)}`,
          );
          console.log();
          console.log(chalk.dim(`  Track it: miosa templates builds ${id}`));
          console.log();
        } catch (err) {
          handleError(err, opts);
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
        const api = client();
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching builds...");
        let rows: TemplateBuild[];
        try {
          rows = await fetchBuilds(api, id);
        } catch (err) {
          spinner?.fail(`Could not fetch builds for ${id}`);
          throw err;
        }
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No builds found."));
          console.log(chalk.dim(`  Start one: miosa templates rebuild ${id}`));
          return;
        }

        renderTable(rows, [
          { header: "BUILD ID", key: (b) => b.id, width: 38 },
          {
            header: "STATE",
            key: (b) => fmtBuildState(b.state),
            width: 14,
          },
          {
            header: "IMAGE",
            key: (b) => b.image_id ?? b.image_digest ?? chalk.dim("-"),
            width: 30,
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
            key: (b) => {
              // The API reports failures as error_code/error_message; reading
              // only `error` meant every failed build showed a blank column.
              const message = buildError(b);
              return message
                ? chalk.red(
                    message.length > 40
                      ? `${message.slice(0, 37)}...`
                      : message,
                  )
                : chalk.dim("-");
            },
            width: 42,
          },
        ]);
      } catch (err) {
        handleError(err, opts);
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

        const api = client();
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Deleting template...");
        let result: unknown;
        try {
          result = await api.apiDelete(
            `/api/v1/sandbox-templates/${encodeURIComponent(id)}`,
          );
        } catch (err) {
          spinner?.fail(`Could not delete template ${id}`);
          // TEMPLATE_IN_USE is a refusal with a specific remedy, not a bug.
          if (
            err instanceof ApiResponseError &&
            err.code === "TEMPLATE_IN_USE"
          ) {
            throw new UserError(
              err.message,
              "Stop the sandboxes booted from this template, or wait for its build to finish, then retry.",
            );
          }
          throw err;
        }
        spinner?.succeed("Template deleted");
        if (json) printJson(result ?? { ok: true });
      } catch (err) {
        handleError(err, opts);
      }
    });
}
