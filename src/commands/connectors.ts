import fs from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { client, enc, runAction, type JsonOptions } from "./enterprise-util.js";
import { printJson } from "./util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";

type ConnectorRecord = {
  id?: string;
  uid?: string;
  provider?: string;
  type?: string;
  display_name?: string;
  status?: string;
  created_at?: string;
  inserted_at?: string;
};

type ConnectorCreateOptions = JsonOptions & {
  type?: string;
  name?: string;
  uid?: string;
  scope?: string;
  workspace?: string;
  value?: string;
  stdin?: boolean;
  file?: string;
};

type ConnectorTokenOptions = JsonOptions & {
  subject?: string;
  installationId?: string;
  scope?: string[];
  audience?: string[];
  validityBufferMs?: string;
};

export function register(program: Command): void {
  const connectors = program
    .command("connectors")
    .alias("provider")
    .description("Manage MIOSA Connect provider connectors and runtime tokens");

  connectors
    .command("list")
    .description("List Connect provider connectors")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(async () => {
        const spinner = isJson(opts) ? null : spin("Fetching connectors...");
        const raw = await client().apiGet<unknown>("/api/v1/connect/connectors");
        spinner?.stop();
        const rows = unwrapList<ConnectorRecord>(raw);

        if (isJson(opts)) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No connectors configured."));
          return;
        }

        renderTable(rows, [
          { header: "UID", key: (row) => row.uid ?? row.id ?? "", width: 34 },
          { header: "PROVIDER", key: (row) => row.provider ?? "", width: 14 },
          { header: "TYPE", key: (row) => row.type ?? "", width: 12 },
          { header: "STATUS", key: (row) => row.status ?? "", width: 12 },
        ]);
      }),
    );

  connectors
    .command("show <connector>")
    .description("Show a Connect provider connector")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/connectors/${enc(connector)}`,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  connectors
    .command("create <provider>")
    .description("Create an API-key backed Connect provider connector")
    .option("--type <type>", "Connector type", "api-key")
    .option("--name <name>", "Stable connector name, e.g. workspace-claude")
    .option("--uid <uid>", "Full connector UID, e.g. anthropic/workspace-claude")
    .option("--scope <scope>", "Credential scope: tenant, workspace, user")
    .option("--workspace <id>", "Workspace ID for workspace-scoped connector")
    .option("--value <value>", "Provider credential value")
    .option("--stdin", "Read provider credential from stdin")
    .option("--file <path>", "Read provider credential from a local file")
    .option("--json", "Output as JSON")
    .action((provider: string, opts: ConnectorCreateOptions) =>
      runAction(async () => {
        const credentialValue = await readCredentialValue(opts);
        const uid = opts.uid ?? `${provider}/${opts.name ?? "default"}`;
        const body: Record<string, unknown> = {
          provider,
          type: normalizeMode(opts.type ?? "api-key"),
          uid,
          scope: opts.scope ?? (opts.workspace ? "workspace" : "tenant"),
          workspace_id: opts.workspace,
          credential: {
            field: "api_key",
            value: credentialValue,
          },
        };

        const spinner = isJson(opts) ? null : spin(`Creating connector ${uid}...`);
        const raw = await client().apiPost<unknown>("/api/v1/connect/connectors", body);
        spinner?.succeed(`Created connector ${uid}`);
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  connectors
    .command("token <connector>")
    .description("Request a short-lived runtime provider token")
    .option("--subject <subject>", "app, user:<id>, or jwt-bearer:<sub>", "app")
    .option("--installation-id <id>", "Provider installation ID")
    .option("--scope <scope>", "Provider scope. Repeatable.", collect, [])
    .option("--audience <audience>", "Provider audience. Repeatable.", collect, [])
    .option("--validity-buffer-ms <ms>", "Refresh buffer in milliseconds")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: ConnectorTokenOptions) =>
      runAction(async () => {
        const body = {
          subject: parseSubject(opts.subject ?? "app"),
          installation_id: opts.installationId,
          scopes: opts.scope?.length ? opts.scope : undefined,
          audience: opts.audience?.length ? opts.audience : undefined,
          validity_buffer_ms: opts.validityBufferMs
            ? Number.parseInt(opts.validityBufferMs, 10)
            : undefined,
        };
        const raw = await client().apiPost<unknown>(
          `/api/v1/connect/token/${enc(connector)}`,
          body,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseSubject(value: string): Record<string, string> {
  if (value === "app") return { type: "app" };
  if (value.startsWith("user:")) return { type: "user", id: value.slice(5) };
  if (value.startsWith("jwt-bearer:")) {
    return { type: "jwt-bearer", sub: value.slice("jwt-bearer:".length) };
  }
  throw new Error("Use --subject app, user:<id>, or jwt-bearer:<sub>");
}

async function readCredentialValue(opts: ConnectorCreateOptions): Promise<string> {
  const sources = [opts.value, opts.stdin ? "stdin" : undefined, opts.file].filter(
    Boolean,
  );
  if (sources.length !== 1) {
    throw new Error("Provide exactly one of --value, --stdin, or --file");
  }
  const raw =
    opts.value ??
    (opts.file ? fs.readFileSync(opts.file, "utf8") : await readStdin());
  const value = raw.trim();
  if (!value) throw new Error("Credential value cannot be empty");
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeMode(value: string): string {
  return value.replaceAll("_", "-");
}

function unwrapData(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in raw) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

function unwrapList<T>(raw: unknown): T[] {
  const data = unwrapData(raw);
  return Array.isArray(data) ? (data as T[]) : [];
}

function printMaybeJson(value: unknown, opts: JsonOptions): void {
  if (isJson(opts)) {
    printJson(value);
    return;
  }
  if (Array.isArray(value)) {
    printJson(value);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      console.log(`${chalk.bold(key.padEnd(18))} ${formatValue(entry)}`);
    }
    return;
  }
  console.log(String(value ?? ""));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return chalk.dim("-");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isJson(opts: JsonOptions): boolean {
  return opts.json === true;
}
