import type { Command } from "commander";
import chalk from "chalk";
import { MiosaClient } from "../client.js";
import { loadConfig } from "../config.js";
import { renderTable } from "../ui/table.js";
import { handleError } from "./util.js";

export type ApiObject = Record<string, unknown>;
export type ApiClient = Pick<
  MiosaClient,
  "apiGet" | "apiPost" | "apiPut" | "apiPatch" | "apiDelete"
>;
export type JsonOptions = { json?: boolean };
export type DataOptions = JsonOptions & { data?: string };

export function client(): ApiClient {
  return new MiosaClient(loadConfig());
}

export function apiPath(path: string): string {
  return path.startsWith("/api/v1/") ? path : `/api/v1${path}`;
}

export function enc(value: string): string {
  return encodeURIComponent(value);
}

export function parseData(data: string | undefined): ApiObject | undefined {
  if (!data) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new Error(
      `Invalid JSON for --data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error("--data must be a JSON object");
  }
  return parsed;
}

export function unwrap<T = unknown>(payload: unknown): T {
  if (isObject(payload) && "data" in payload) return payload["data"] as T;
  return payload as T;
}

export async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    handleError(err);
  }
}

export async function getAndPrint(
  path: string,
  opts: JsonOptions,
): Promise<void> {
  const value = unwrap(await client().apiGet<unknown>(apiPath(path)));
  printValue(value, opts);
}

export async function postAndPrint(
  path: string,
  opts: DataOptions,
  defaultBody?: ApiObject,
): Promise<void> {
  const body = parseData(opts.data) ?? defaultBody;
  const value = unwrap(await client().apiPost<unknown>(apiPath(path), body));
  printValue(value, opts);
}

export async function putAndPrint(
  path: string,
  opts: DataOptions,
  defaultBody?: ApiObject,
): Promise<void> {
  const body = parseData(opts.data) ?? defaultBody;
  const value = unwrap(await client().apiPut<unknown>(apiPath(path), body));
  printValue(value, opts);
}

export async function deleteAndPrint(
  path: string,
  opts: JsonOptions,
): Promise<void> {
  const value = unwrap(await client().apiDelete<unknown>(apiPath(path)));
  if (opts.json) {
    console.log(JSON.stringify(value ?? { deleted: true }, null, 2));
    return;
  }
  console.log(chalk.green("Deleted."));
}

export function addDataOption(command: Command): Command {
  return command.option("--data <json>", "JSON object request body");
}

export function printValue(value: unknown, opts: JsonOptions): void {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    printList(value);
    return;
  }
  if (isObject(value)) {
    printObject(value);
    return;
  }
  if (value === undefined || value === null || value === "") {
    console.log(chalk.dim("(no content)"));
    return;
  }
  console.log(String(value));
}

export function printList(items: unknown[]): void {
  const rows = items.filter(isObject);
  if (rows.length !== items.length) {
    for (const item of items) console.log(String(item));
    return;
  }
  renderTable<ApiObject>(
    rows,
    tableColumns(rows).map((key) => ({
      header: key.toUpperCase().replaceAll("_", " "),
      key: (row) => formatCell(row[key]),
      width: key === "id" ? 12 : undefined,
    })),
  );
}

export function printObject(row: ApiObject): void {
  for (const [key, value] of Object.entries(row)) {
    console.log(`${chalk.bold(key.padEnd(18))} ${formatCell(value)}`);
  }
}

export function resourceCommands(config: {
  program: Command;
  command: string;
  description: string;
  route: string;
  itemName?: string;
  actions?: readonly string[];
}): void {
  const group = config.program
    .command(config.command)
    .description(config.description);
  const itemName = config.itemName ?? "id";

  group
    .command("list")
    .description(`List ${config.command}`)
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(() => getAndPrint(config.route, opts)),
    );

  group
    .command(`show <${itemName}>`)
    .description(`Show a ${config.command} item`)
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => getAndPrint(`${config.route}/${enc(id)}`, opts)),
    );

  addDataOption(
    group.command("create").description(`Create a ${config.command} item`),
  )
    .option("--json", "Output as JSON")
    .action((opts: DataOptions) =>
      runAction(() => postAndPrint(config.route, opts, {})),
    );

  group
    .command(`delete <${itemName}>`)
    .description(`Delete a ${config.command} item`)
    .option("--json", "Output as JSON")
    .action((id: string, opts: JsonOptions) =>
      runAction(() => deleteAndPrint(`${config.route}/${enc(id)}`, opts)),
    );

  if (config.actions && config.actions.length > 0) {
    addDataOption(
      group
        .command(`action <${itemName}> <action>`)
        .description(`Run an action: ${config.actions.join(", ")}`),
    )
      .option("--json", "Output as JSON")
      .action((id: string, action: string, opts: DataOptions) =>
        runAction(async () => {
          requireAction(action, config.actions ?? []);
          await postAndPrint(`${config.route}/${enc(id)}/${enc(action)}`, opts);
        }),
      );
  }
}

export function requireAction(
  action: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(action)) {
    throw new Error(
      `Unsupported action "${action}". Use: ${allowed.join(", ")}`,
    );
  }
}

function tableColumns(rows: ApiObject[]): string[] {
  const preferred = [
    "id",
    "name",
    "status",
    "state",
    "type",
    "host_id",
    "created_at",
    "inserted_at",
    "updated_at",
  ];
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  const selected = preferred.filter((key) => keys.has(key));
  if (selected.length > 0) return selected.slice(0, 6);
  return Array.from(keys).slice(0, 6);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return chalk.dim("-");
  if (typeof value === "string") {
    return value.length > 48 ? `${value.slice(0, 45)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function isObject(value: unknown): value is ApiObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
