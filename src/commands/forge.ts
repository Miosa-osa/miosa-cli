import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import chalk from "chalk";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { UserError } from "../errors.js";
import { renderTable } from "../ui/table.js";
import { handleError, isJsonMode } from "./util.js";

type ForgeVisibility = "public" | "private" | "internal";
type ForgeState =
  | "provisioning"
  | "active"
  | "error"
  | "deletion_pending"
  | "deleted";

interface ForgeRepository {
  id: string;
  name: string;
  slug: string;
  default_branch: string;
  visibility: ForgeVisibility;
  state: ForgeState;
  clone_ready: boolean;
  clone_url: string | null;
  project_ids: string[];
  created_at: string;
  updated_at: string;
}

interface ForgeEnvelope<T> {
  data: T;
}

interface OutputOptions {
  json?: boolean;
}

interface CreateOptions extends OutputOptions {
  slug?: string;
  defaultBranch: string;
  visibility: string;
  projectId: string[];
  idempotencyKey?: string;
}

interface UpdateOptions extends OutputOptions {
  name?: string;
  slug?: string;
  visibility?: string;
  projectId?: string[];
}

const VISIBILITIES = new Set<ForgeVisibility>([
  "public",
  "private",
  "internal",
]);
const STATES = new Set<ForgeState>([
  "provisioning",
  "active",
  "error",
  "deletion_pending",
  "deleted",
]);

function repositoryPath(id?: string): string {
  const root = "/api/v1/forge/repositories";
  return id ? `${root}/${encodeURIComponent(id)}` : root;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`Forge returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new UserError(`Forge repository response is missing ${key}.`);
  }
  return field;
}

function parseRepository(payload: unknown): ForgeRepository {
  const value = record(payload, "repository data");
  const visibility = requiredString(value, "visibility");
  const state = requiredString(value, "state");
  if (!VISIBILITIES.has(visibility as ForgeVisibility)) {
    throw new UserError("Forge repository response has invalid visibility.");
  }
  if (!STATES.has(state as ForgeState)) {
    throw new UserError("Forge repository response has invalid state.");
  }
  if (
    typeof value["clone_ready"] !== "boolean" ||
    (value["clone_url"] !== null && typeof value["clone_url"] !== "string") ||
    !Array.isArray(value["project_ids"]) ||
    !value["project_ids"].every((id) => typeof id === "string")
  ) {
    throw new UserError(
      "Forge repository response has invalid clone metadata.",
    );
  }
  const cloneReady = value["clone_ready"];
  const cloneUrl = value["clone_url"] as string | null;
  if (
    cloneReady !== (state === "active") ||
    (cloneReady && !cloneUrl) ||
    (!cloneReady && cloneUrl !== null)
  ) {
    throw new UserError("Forge repository clone readiness is inconsistent.");
  }
  return {
    id: requiredString(value, "id"),
    name: requiredString(value, "name"),
    slug: requiredString(value, "slug"),
    default_branch: requiredString(value, "default_branch"),
    visibility: visibility as ForgeVisibility,
    state: state as ForgeState,
    clone_ready: cloneReady,
    clone_url: cloneUrl,
    project_ids: value["project_ids"] as string[],
    created_at: requiredString(value, "created_at"),
    updated_at: requiredString(value, "updated_at"),
  };
}

function parseEnvelope(payload: unknown): ForgeRepository {
  return parseRepository(record(payload, "response envelope")["data"]);
}

function parseList(payload: unknown): ForgeRepository[] {
  const data = record(payload, "response envelope")["data"];
  if (!Array.isArray(data)) {
    throw new UserError("Forge returned an invalid repository list.");
  }
  return data.map(parseRepository);
}

function visibility(value: string): ForgeVisibility {
  if (!VISIBILITIES.has(value as ForgeVisibility)) {
    throw new UserError("Visibility must be public, private, or internal.");
  }
  return value as ForgeVisibility;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function printRepository(repository: ForgeRepository): void {
  renderTable(
    [
      { field: "Name", value: repository.name },
      { field: "Slug", value: repository.slug },
      { field: "ID", value: repository.id },
      { field: "Default branch", value: repository.default_branch },
      { field: "Visibility", value: repository.visibility },
      { field: "State", value: repository.state },
      { field: "Clone URL", value: repository.clone_url ?? "Not ready" },
    ],
    [
      { header: "FIELD", key: "field" },
      { header: "VALUE", key: "value" },
    ],
  );
}

function printSuccess<T>(data: T, opts: OutputOptions): boolean {
  if (!isJsonMode(opts)) return false;
  console.log(JSON.stringify({ data }, null, 2));
  return true;
}

function idempotencyKey(): string {
  return `forge-cli-${randomBytes(16).toString("hex")}`;
}

export function register(program: Command): void {
  const forge = program
    .command("forge")
    .description("Work with MIOSA Forge repositories (beta)");
  const repo = forge.command("repo").description("Manage Forge repositories");

  repo
    .command("list")
    .alias("ls")
    .description("List repositories in the current organization")
    .option("--json", "Output a stable JSON envelope")
    .action(async (opts: OutputOptions) => {
      try {
        const repositories = parseList(
          await new MiosaClient(loadConfig()).apiGet(repositoryPath()),
        );
        if (printSuccess(repositories, opts)) return;
        renderTable(repositories, [
          { header: "NAME", key: "name" },
          { header: "SLUG", key: "slug" },
          { header: "VISIBILITY", key: "visibility" },
          { header: "STATE", key: "state" },
          { header: "ID", key: "id" },
        ]);
      } catch (err) {
        handleError(err, opts);
      }
    });

  repo
    .command("create <name>")
    .description("Create a repository in the current organization")
    .option("--slug <slug>", "Repository URL slug")
    .option("--default-branch <branch>", "Default branch name", "main")
    .option(
      "--visibility <visibility>",
      "Repository visibility: public, private, or internal",
      "private",
    )
    .option("--project-id <id...>", "Attach project IDs")
    .option(
      "--idempotency-key <key>",
      "Stable key for safely retrying this mutation",
    )
    .option("--json", "Output a stable JSON envelope")
    .action(async (name: string, opts: CreateOptions) => {
      try {
        const repository = parseEnvelope(
          await new MiosaClient(loadConfig()).apiPost(
            repositoryPath(),
            compact({
              name,
              slug: opts.slug,
              default_branch: opts.defaultBranch,
              visibility: visibility(opts.visibility),
              project_ids: opts.projectId,
            }),
            { "Idempotency-Key": opts.idempotencyKey ?? idempotencyKey() },
          ),
        );
        if (printSuccess(repository, opts)) return;
        console.log(chalk.green(`Created repository ${repository.slug}.`));
        printRepository(repository);
      } catch (err) {
        handleError(err, opts);
      }
    });

  repo
    .command("show <repository-id>")
    .description("Show a repository in the current organization")
    .option("--json", "Output a stable JSON envelope")
    .action(async (id: string, opts: OutputOptions) => {
      try {
        const repository = parseEnvelope(
          await new MiosaClient(loadConfig()).apiGet(repositoryPath(id)),
        );
        if (printSuccess(repository, opts)) return;
        printRepository(repository);
      } catch (err) {
        handleError(err, opts);
      }
    });

  repo
    .command("update <repository-id>")
    .description("Update a repository")
    .option("--name <name>", "Repository display name")
    .option("--slug <slug>", "Repository URL slug")
    .option("--visibility <visibility>", "Repository visibility")
    .option("--project-id <id...>", "Replace attached project IDs")
    .option("--json", "Output a stable JSON envelope")
    .action(async (id: string, opts: UpdateOptions) => {
      try {
        const body = compact({
          name: opts.name,
          slug: opts.slug,
          visibility:
            opts.visibility === undefined
              ? undefined
              : visibility(opts.visibility),
          project_ids: opts.projectId,
        });
        if (Object.keys(body).length === 0) {
          throw new UserError("Pass at least one field to update.");
        }
        const repository = parseEnvelope(
          await new MiosaClient(loadConfig()).apiPatch(
            repositoryPath(id),
            body,
          ),
        );
        if (printSuccess(repository, opts)) return;
        console.log(chalk.green(`Updated repository ${repository.slug}.`));
      } catch (err) {
        handleError(err, opts);
      }
    });

  repo
    .command("delete <repository-id>")
    .description("Permanently delete a repository")
    .option("-y, --yes", "Confirm permanent deletion without prompting")
    .option("--json", "Output a stable JSON envelope")
    .action(async (id: string, opts: OutputOptions & { yes?: boolean }) => {
      try {
        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            throw new UserError(
              "Confirmation required for non-interactive deletion.",
              "Re-run with --yes after verifying the repository ID.",
            );
          }
          const { default: inquirer } = await import("inquirer");
          const { confirmation } = await inquirer.prompt<{
            confirmation: string;
          }>([
            {
              type: "input",
              name: "confirmation",
              message: `Type ${id} to permanently delete this repository:`,
            },
          ]);
          if (confirmation !== id) {
            throw new UserError("Repository deletion cancelled.");
          }
        }
        const receipt = await new MiosaClient(
          loadConfig(),
        ).apiDeleteWithReceipt(repositoryPath(id));
        const result = {
          id,
          status: "deleted",
          operation_id: receipt.operationId,
          replayed: receipt.replayed,
        };
        if (printSuccess(result, opts)) return;
        console.log(chalk.green(`Deleted repository ${id}.`));
      } catch (err) {
        handleError(err, opts);
      }
    });
}
