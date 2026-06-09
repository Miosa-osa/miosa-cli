import type { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../ui/table.js";
import {
  createClient,
  handleError,
  isJsonMode,
  objectOf,
  printJson,
  shortId,
} from "./util.js";

type HostStatus =
  | "pending"
  | "provisioning"
  | "bootstrapping"
  | "active"
  | "degraded"
  | "suspended"
  | "retired"
  | "error";

interface DockerDeployHost {
  [key: string]: unknown;
  id: string;
  tenant_id: string;
  workspace_id: string;
  external_workspace_id?: string | null;
  computer_id?: string | null;
  status: HostStatus | string;
  size: string;
  region: string;
  portal_domain?: string | null;
  runtime_base_url?: string | null;
  agent_base_url?: string | null;
  appliance_image?: string | null;
  appliance_version?: string | null;
  appliance_status?: string | null;
  agent_last_seen_at?: string | null;
  updated_at?: string | null;
}

interface DockerDeployTemplate {
  [key: string]: unknown;
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  runtime?: string | null;
  tags?: string[] | null;
}

function unwrapHosts(payload: unknown): DockerDeployHost[] {
  if (Array.isArray(payload)) return payload as DockerDeployHost[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["data"])) return record["data"] as DockerDeployHost[];
    if (Array.isArray(record["hosts"])) return record["hosts"] as DockerDeployHost[];
  }
  return [];
}

function unwrapTemplates(payload: unknown): DockerDeployTemplate[] {
  if (Array.isArray(payload)) return payload as DockerDeployTemplate[];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["data"])) return record["data"] as DockerDeployTemplate[];
    if (Array.isArray(record["templates"])) return record["templates"] as DockerDeployTemplate[];
  }
  return [];
}

function statusLabel(status: string): string {
  switch (status) {
    case "active":
      return chalk.green(status);
    case "bootstrapping":
    case "provisioning":
    case "pending":
      return chalk.yellow(status);
    case "degraded":
    case "error":
      return chalk.red(status);
    default:
      return chalk.dim(status);
  }
}

function hostReady(host: DockerDeployHost): boolean {
  return host.status === "active" && host.appliance_status === "healthy";
}

function printHost(host: DockerDeployHost): void {
  console.log();
  console.log(chalk.bold("Docker Deploy host"));
  console.log();
  console.log(`  ID:          ${host.id}`);
  console.log(`  Workspace:   ${host.workspace_id}`);
  if (host.external_workspace_id) {
    console.log(`  External:    ${host.external_workspace_id}`);
  }
  console.log(`  Computer:    ${host.computer_id ?? "—"}`);
  console.log(`  Status:      ${statusLabel(host.status)}`);
  console.log(`  Appliance:   ${host.appliance_status ?? "unknown"}`);
  console.log(`  Ready:       ${hostReady(host) ? chalk.green("yes") : chalk.yellow("no")}`);
  console.log(`  Size/region: ${host.size} / ${host.region}`);
  console.log(`  Portal:      ${host.portal_domain ?? "—"}`);
  console.log(`  Runtime:     ${host.runtime_base_url ?? "—"}`);
  console.log(`  Updated:     ${host.updated_at ?? "—"}`);
  console.log();
}

function printTemplate(template: DockerDeployTemplate): void {
  console.log();
  console.log(chalk.bold(template.name));
  console.log();
  console.log(`  ID:          ${template.id}`);
  console.log(`  Category:    ${template.category ?? "—"}`);
  console.log(`  Runtime:     ${template.runtime ?? "—"}`);
  console.log(`  Tags:        ${(template.tags ?? []).join(", ") || "—"}`);
  if (template.description) {
    console.log(`  Description: ${template.description}`);
  }
  console.log();
}

export function register(program: Command): void {
  const root = program
    .command("docker-deploy")
    .alias("docker")
    .description("Manage MIOSA Docker Deploy appliance hosts");

  root
    .command("hosts")
    .alias("list")
    .description("List Docker Deploy appliance hosts")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--json", "Output raw JSON")
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      try {
        const client = createClient();
        const params = new URLSearchParams();
        if (opts.workspace) params.set("workspace_id", opts.workspace);
        const suffix = params.toString() ? `?${params.toString()}` : "";
        const raw = await client.apiGet<unknown>(`/api/v1/docker-deploy/hosts${suffix}`);
        const hosts = unwrapHosts(raw);

        if (isJsonMode(opts) || opts.json) {
          printJson(hosts);
          return;
        }

        console.log();
        console.log(`${chalk.bold(String(hosts.length))} Docker Deploy host(s)`);
        console.log();
        renderTable(hosts, [
          { header: "ID", key: (h) => shortId(h.id), width: 10 },
          { header: "WORKSPACE", key: (h) => shortId(h.workspace_id), width: 12 },
          { header: "STATUS", key: (h) => h.status, width: 14, color: (v) => statusLabel(v.trim()).padEnd(14) },
          { header: "APPLIANCE", key: (h) => h.appliance_status ?? "unknown", width: 14 },
          { header: "COMPUTER", key: (h) => shortId(h.computer_id), width: 12 },
          { header: "PORTAL", key: (h) => h.portal_domain ?? "—", width: 28 },
        ]);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  root
    .command("templates")
    .description("List Docker Deploy starter templates")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const raw = await client.apiGet<unknown>("/api/v1/docker-deploy/templates");
        const templates = unwrapTemplates(raw);

        if (isJsonMode(opts) || opts.json) {
          printJson(templates);
          return;
        }

        console.log();
        console.log(`${chalk.bold(String(templates.length))} Docker Deploy template(s)`);
        console.log();
        renderTable(templates, [
          { header: "ID", key: (t) => t.id, width: 24 },
          { header: "NAME", key: (t) => t.name, width: 28 },
          { header: "CATEGORY", key: (t) => t.category ?? "—", width: 16 },
          { header: "RUNTIME", key: (t) => t.runtime ?? "—", width: 16 },
        ]);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  root
    .command("template")
    .description("Show one Docker Deploy starter template")
    .argument("<template-id>", "Docker Deploy template ID")
    .option("--json", "Output raw JSON")
    .action(async (templateId: string, opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const raw = await client.apiGet<unknown>(
          `/api/v1/docker-deploy/templates/${encodeURIComponent(templateId)}`,
        );
        const template = objectOf<DockerDeployTemplate>(raw, ["template"]);

        if (isJsonMode(opts) || opts.json) {
          printJson(template);
          return;
        }

        printTemplate(template);
      } catch (err) {
        handleError(err);
      }
    });

  root
    .command("ensure")
    .description("Provision or return the workspace Docker Deploy host")
    .option("--workspace <id>", "Workspace ID")
    .option("--external-workspace <id>", "External workspace/customer ID")
    .option("--json", "Output raw JSON")
    .action(async (opts: { workspace?: string; externalWorkspace?: string; json?: boolean }) => {
      try {
        const client = createClient();
        const raw = await client.apiPost<unknown>("/api/v1/docker-deploy/hosts/ensure", {
          ...(opts.workspace ? { workspace_id: opts.workspace } : {}),
          ...(opts.externalWorkspace ? { external_workspace_id: opts.externalWorkspace } : {}),
        });
        const host = objectOf<DockerDeployHost>(raw, ["host"]);

        if (isJsonMode(opts) || opts.json) {
          printJson(host);
          return;
        }

        printHost(host);
        if (!hostReady(host)) {
          console.log(
            chalk.dim(
              "  The appliance is not ready yet. Re-run `miosa docker-deploy show " +
                host.id +
                "` until status=active and appliance=healthy.",
            ),
          );
          console.log();
        }
      } catch (err) {
        handleError(err);
      }
    });

  root
    .command("show")
    .description("Show one Docker Deploy appliance host")
    .argument("<host-id>", "Docker Deploy host ID")
    .option("--json", "Output raw JSON")
    .action(async (hostId: string, opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const raw = await client.apiGet<unknown>(
          `/api/v1/docker-deploy/hosts/${encodeURIComponent(hostId)}`,
        );
        const host = objectOf<DockerDeployHost>(raw, ["host"]);

        if (isJsonMode(opts) || opts.json) {
          printJson(host);
          return;
        }

        printHost(host);
      } catch (err) {
        handleError(err);
      }
    });
}
