import type { Command } from "commander";
import chalk from "chalk";
import type { Deployment } from "../types.js";
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

interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

interface DoctorProbe {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

type DeploymentRecord = Deployment & Record<string, unknown>;

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

function deploymentProduct(deployment: Deployment): unknown {
  return deployment.deployment_product ?? deployment.metadata?.["deployment_product"];
}

function dockerDeployHostId(deployment: Deployment): string | null {
  const metadataHost = deployment.metadata?.["docker_deploy_host_id"];
  return deployment.docker_deploy_host_id ?? (typeof metadataHost === "string" ? metadataHost : null);
}

function runtimeRoute(deployment: Deployment): Record<string, unknown> | null {
  const runtime = deployment.metadata?.["runtime"];
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return null;
  const record = runtime as Record<string, unknown>;
  return typeof record["ip"] === "string" && typeof record["port"] === "number" ? record : null;
}

function dockerDeployApp(deployment: Deployment): Record<string, unknown> | null {
  const app = deployment.metadata?.["docker_deploy"];
  if (!app || typeof app !== "object" || Array.isArray(app)) return null;
  return app as Record<string, unknown>;
}

function dockerDeployAppPort(app: Record<string, unknown> | null): number | null {
  const url = app?.["url"];
  if (typeof url !== "string") return null;

  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

function addCheck(
  checks: DoctorCheck[],
  name: string,
  ok: boolean,
  message: string,
  details?: Record<string, unknown>,
): void {
  checks.push({ name, ok, message, ...(details ? { details } : {}) });
}

function checkIcon(ok: boolean): string {
  return ok ? chalk.green("ok") : chalk.red("fail");
}

function probeUrl(publicUrl: string, probePath: string): string {
  const url = new URL(publicUrl);
  url.pathname = probePath.startsWith("/") ? probePath : `/${probePath}`;
  return url.toString();
}

async function probePublicUrl(publicUrl: string, probePath: string, timeoutMs: number): Promise<DoctorProbe> {
  const url = probeUrl(publicUrl, probePath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return { url, ok: response.ok, status: response.status };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
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
  console.log(`  Agent:       ${host.agent_base_url ?? "—"}`);
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

  root
    .command("doctor")
    .description("Verify a Docker Deploy deployment before reporting it live")
    .argument("<deployment-id>", "Deployment ID")
    .option("--probe-path <path>", "Public URL path to probe", "/")
    .option("--timeout <ms>", "Public URL probe timeout in milliseconds", "10000")
    .option("--json", "Output raw JSON")
    .action(async (deploymentId: string, opts: { probePath?: string; timeout?: string; json?: boolean }) => {
      try {
        const client = createClient();
        const checks: DoctorCheck[] = [];
        const deployment = objectOf<DeploymentRecord>(
          await client.apiGet<unknown>(`/api/v1/deployments/${encodeURIComponent(deploymentId)}`),
        );
        const product = deploymentProduct(deployment);
        const hostId = dockerDeployHostId(deployment);

        addCheck(
          checks,
          "deployment_product",
          product === "docker_deploy",
          product === "docker_deploy"
            ? "Deployment is marked for Docker Deploy."
            : `Expected deployment_product=docker_deploy, got ${String(product ?? "missing")}.`,
          { deployment_product: product ?? null },
        );

        addCheck(
          checks,
          "docker_deploy_host_id",
          Boolean(hostId),
          hostId ? "Deployment has a Docker Deploy host id." : "Deployment has no docker_deploy_host_id.",
          { docker_deploy_host_id: hostId },
        );

        let host: DockerDeployHost | null = null;
        if (hostId) {
          host = objectOf<DockerDeployHost>(
            await client.apiGet<unknown>(`/api/v1/docker-deploy/hosts/${encodeURIComponent(hostId)}`),
            ["host"],
          );
          addCheck(
            checks,
            "docker_deploy_host_health",
            hostReady(host),
            hostReady(host)
              ? "Docker Deploy host is active and healthy."
              : `Docker Deploy host status=${host.status} appliance=${host.appliance_status}.`,
            { status: host.status, appliance_status: host.appliance_status },
          );
        }

        const app = dockerDeployApp(deployment);
        const appPort = dockerDeployAppPort(app);
        const appRunning = app?.["status"] === "running" && appPort !== null;
        addCheck(
          checks,
          "docker_deploy_app",
          appRunning,
          appRunning
            ? "Docker Deploy app metadata points at a running container."
            : "Deployment is missing running Docker Deploy app metadata.",
          app
            ? {
                app_id: app["app_id"],
                container_id: app["container_id"],
                status: app["status"],
                url: app["url"],
                expected_port: appPort,
              }
            : undefined,
        );

        const runtime = runtimeRoute(deployment);
        const routeMatchesContainerPort =
          Boolean(runtime) && (appPort === null || runtime?.["port"] === appPort);
        addCheck(
          checks,
          "runtime_route",
          Boolean(runtime) && routeMatchesContainerPort,
          runtime && routeMatchesContainerPort
            ? "Deployment route points at the Docker container host port."
            : runtime && appPort !== null
              ? `Deployment route port ${String(runtime["port"])} does not match Docker container host port ${appPort}.`
            : "Deployment is missing appliance runtime route metadata.",
          runtime
            ? {
                ...runtime,
                expected_port: appPort,
                docker_deploy_url: app?.["url"],
              }
            : undefined,
        );

        let probe: DoctorProbe | null = null;
        if (deployment.public_url) {
          probe = await probePublicUrl(
            deployment.public_url,
            opts.probePath ?? "/",
            Number.parseInt(opts.timeout ?? "10000", 10),
          );
          addCheck(
            checks,
            "public_url_probe",
            probe.ok,
            probe.status
              ? `Public URL returned HTTP ${probe.status}.`
              : probe.error ?? "Public URL probe failed.",
            { url: probe.url, ...(probe.status ? { status: probe.status } : {}) },
          );
        }

        const result = {
          ok: checks.every((check) => check.ok),
          deployment_id: deployment.id,
          deployment_product: product,
          docker_deploy_host_id: hostId,
          public_url: deployment.public_url ?? null,
          host,
          checks,
          probe,
        };

        if (isJsonMode(opts) || opts.json) {
          printJson(result);
        } else {
          console.log();
          console.log(chalk.bold("Docker Deploy doctor"));
          console.log();
          console.log(`  Deployment: ${deployment.id}`);
          console.log(`  URL:        ${deployment.public_url ?? "—"}`);
          console.log(`  Host:       ${hostId ?? "—"}`);
          console.log();
          for (const check of checks) {
            console.log(`  ${checkIcon(check.ok)} ${check.name}: ${check.message}`);
          }
          console.log();
        }

        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });
}
