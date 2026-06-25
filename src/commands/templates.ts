import type { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../ui/table.js";
import { createClient, handleError, isJsonMode, printJson } from "./util.js";
import { spin } from "../ui/spinner.js";

type ProductId =
  | "sandbox"
  | "computer"
  | "docker_deploy_host"
  | "managed_database"
  | "deployment";

interface TemplateSizeReadiness {
  size?: string;
  state?: string;
  fast_ready?: boolean;
  ready_nodes?: number;
  checked_nodes?: number;
}

interface ProductTemplate {
  id: string;
  name?: string;
  product?: ProductId | string;
  description?: string;
  default_size?: string;
  sdk_name?: string;
  cli_name?: string;
  installed_tools?: string[];
  install_command?: string | null;
  start_command?: string | null;
  benchmark_lane?: { id?: string; command?: string; name?: string };
  readiness_contract?: {
    exec_ready?: boolean;
    preview_ready?: boolean;
    desktop_ready?: boolean;
    app_ready?: boolean;
    benchmark_command?: string;
  };
  sizes?: TemplateSizeReadiness[];
}

interface TemplateCatalog {
  templates?: ProductTemplate[];
  data?: { templates?: ProductTemplate[] };
}

function catalogTemplates(raw: TemplateCatalog | ProductTemplate[]): ProductTemplate[] {
  if (Array.isArray(raw)) return raw;
  return raw.data?.templates ?? raw.templates ?? [];
}

function byProduct(
  templates: ProductTemplate[],
  product?: string,
): ProductTemplate[] {
  if (!product) return templates;
  return templates.filter((template) => template.product === product);
}

function findTemplate(
  templates: ProductTemplate[],
  templateId: string,
): ProductTemplate {
  const match = templates.find((template) => template.id === templateId);
  if (!match) throw new Error(`Template not found: ${templateId}`);
  return match;
}

function stateLabel(state: string | undefined): string {
  if (!state) return chalk.dim("-");
  if (state === "fast_ready") return chalk.green(state);
  if (state === "partial_fast_ready") return chalk.yellow(state);
  if (state === "cold_boot_only") return chalk.yellow(state);
  if (state === "missing" || state === "unavailable") return chalk.red(state);
  return chalk.dim(state);
}

function sizeSummary(template: ProductTemplate): string {
  const sizes = template.sizes ?? [];
  if (sizes.length === 0) return chalk.dim("-");
  return sizes
    .map((size) => {
      const name = size.size ?? "?";
      const state = size.state ?? (size.fast_ready ? "fast_ready" : "unknown");
      return `${name}:${state}`;
    })
    .join(", ");
}

function readinessRows(template: ProductTemplate): TemplateSizeReadiness[] {
  return template.sizes ?? [];
}

export function register(program: Command): void {
  const templates = program
    .command("templates")
    .description("Discover canonical product templates and size readiness");

  templates
    .command("list")
    .description("List canonical templates for sandbox, computer, and appliance products")
    .option("--product <product>", "Filter by product: sandbox, computer, docker_deploy_host")
    .option("--json", "Output raw JSON")
    .action(async (opts: { product?: string; json?: boolean }) => {
      try {
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching product templates...");
        const raw = await createClient().apiGet<TemplateCatalog>("/api/v1/templates");
        const rows = byProduct(catalogTemplates(raw), opts.product);
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No product templates found."));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (t) => t.id, width: 24 },
          { header: "PRODUCT", key: (t) => t.product ?? "-", width: 18 },
          { header: "DEFAULT", key: (t) => t.default_size ?? "-", width: 10 },
          { header: "SDK", key: (t) => t.sdk_name ?? "-", width: 18 },
          { header: "CLI", key: (t) => t.cli_name ?? "-", width: 18 },
          { header: "SIZES", key: sizeSummary, width: 54 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  templates
    .command("get <template-id>")
    .description("Show one canonical product template")
    .option("--json", "Output raw JSON")
    .action(async (templateId: string, opts: { json?: boolean }) => {
      try {
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching product template...");
        const raw = await createClient().apiGet<TemplateCatalog>("/api/v1/templates");
        const template = findTemplate(catalogTemplates(raw), templateId);
        spinner?.stop();

        if (json) {
          printJson(template);
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}          ${template.id}`);
        console.log(`  ${chalk.bold("Product")}     ${template.product ?? "-"}`);
        console.log(`  ${chalk.bold("Name")}        ${template.name ?? "-"}`);
        console.log(`  ${chalk.bold("Default")}     ${template.default_size ?? "-"}`);
        console.log(`  ${chalk.bold("SDK")}         ${template.sdk_name ?? "-"}`);
        console.log(`  ${chalk.bold("CLI")}         ${template.cli_name ?? "-"}`);
        if (template.description) {
          console.log(`  ${chalk.bold("Purpose")}     ${template.description}`);
        }
        if (template.installed_tools?.length) {
          console.log(
            `  ${chalk.bold("Tools")}       ${template.installed_tools.join(", ")}`,
          );
        }
        if (template.install_command) {
          console.log(`  ${chalk.bold("Install")}     ${template.install_command}`);
        }
        if (template.start_command) {
          console.log(`  ${chalk.bold("Start")}       ${template.start_command}`);
        }
        if (template.benchmark_lane?.id) {
          console.log(`  ${chalk.bold("Benchmark")}   ${template.benchmark_lane.id}`);
        }
        console.log();
        console.log(chalk.bold("  Size readiness"));
        renderTable(readinessRows(template), [
          { header: "SIZE", key: (r) => r.size ?? "-", width: 10 },
          { header: "STATE", key: (r) => stateLabel(r.state), width: 18 },
          {
            header: "NODES",
            key: (r) =>
              r.checked_nodes === undefined
                ? "-"
                : `${r.ready_nodes ?? 0}/${r.checked_nodes}`,
            width: 10,
          },
        ]);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  templates
    .command("readiness <template-id>")
    .description("Show size readiness for one canonical product template")
    .option("--json", "Output raw JSON")
    .action(async (templateId: string, opts: { json?: boolean }) => {
      try {
        const json = isJsonMode(opts);
        const spinner = json ? null : spin("Fetching template readiness...");
        const raw = await createClient().apiGet<TemplateCatalog>("/api/v1/templates");
        const template = findTemplate(catalogTemplates(raw), templateId);
        const rows = readinessRows(template);
        spinner?.stop();

        if (json) {
          printJson(rows);
          return;
        }

        renderTable(rows, [
          { header: "SIZE", key: (r) => r.size ?? "-", width: 10 },
          { header: "STATE", key: (r) => stateLabel(r.state), width: 18 },
          {
            header: "NODES",
            key: (r) =>
              r.checked_nodes === undefined
                ? "-"
                : `${r.ready_nodes ?? 0}/${r.checked_nodes}`,
            width: 10,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });
}
