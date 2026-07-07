import type { Command } from "commander";
import chalk from "chalk";
import { request } from "undici";
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

interface DockerDeployProbe {
  ok: boolean;
  status?: number;
  url?: string;
  error?: string;
  body_kind?: "empty" | "miosa_gateway_json" | "html" | "json" | "text";
}

interface DockerDeployCheck {
  id: string;
  ok: boolean;
  message: string;
  recovery?: string[];
}

interface DockerDeployAppTruth {
  id?: string | null;
  docker_deploy_host_id?: string | null;
  app_id?: string | null;
  container_id?: string | null;
  status?: string | null;
  runtime_ip?: string | null;
  runtime_port?: number | string | null;
  public_url?: string | null;
  last_health_status?: string | null;
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
  console.log(chalk.bold("App Engine host"));
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string | null {
  const raw = asRecord(value)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function numberField(value: unknown, key: string): number | null {
  const raw = asRecord(value)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function deploymentProduct(deployment: Deployment): string {
  const metadata = asRecord(deployment.metadata);
  return (
    deployment.deployment_product ??
    stringField(metadata, "deployment_product") ??
    "miosa_deploy"
  );
}

function deploymentHostId(deployment: Deployment): string | null {
  const metadata = asRecord(deployment.metadata);
  const app = deploymentDockerDeployApp(deployment);
  return (
    stringField(app, "docker_deploy_host_id") ??
    deployment.docker_deploy_host_id ??
    stringField(metadata, "docker_deploy_host_id") ??
    stringField(asRecord(metadata["docker_deploy"]), "host_id")
  );
}

function deploymentRuntime(deployment: Deployment): {
  ip: string | null;
  port: number | null;
} {
  const app = deploymentDockerDeployApp(deployment);
  const runtime = asRecord(asRecord(deployment.metadata)["runtime"]);
  return {
    ip: stringField(app, "runtime_ip") ?? stringField(runtime, "ip"),
    port: numberField(app, "runtime_port") ?? numberField(runtime, "port"),
  };
}

function deploymentPublicUrl(deployment: Deployment): string | null {
  return (
    stringField(deploymentDockerDeployApp(deployment), "public_url") ??
    deployment.public_url ??
    deployment.auto_subdomain ??
    null
  );
}

function deploymentDockerDeployApp(deployment: Deployment): DockerDeployAppTruth | null {
  const raw = asRecord(deployment as unknown as Record<string, unknown>)["docker_deploy_app"];
  return raw && typeof raw === "object" ? (raw as DockerDeployAppTruth) : null;
}

function classifyBody(contentType: string | null, body: string): DockerDeployProbe["body_kind"] {
  const trimmed = body.trim();
  if (!trimmed) return "empty";
  if (contentType?.includes("text/html") || /^<!doctype html/i.test(trimmed)) return "html";
  if (contentType?.includes("application/json") || /^[{[]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      if (record["ok"] === true && typeof record["run_id"] === "string") {
        return "miosa_gateway_json";
      }
    } catch {
      // Fall through to generic JSON classification.
    }
    return "json";
  }
  return "text";
}

async function probeUrl(
  baseUrl: string | null,
  probePath: string,
  timeoutMs: number,
): Promise<DockerDeployProbe> {
  if (!baseUrl) return { ok: false, error: "deployment has no public_url" };
  const url = new URL(probePath || "/", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, {
      method: "GET",
      signal: controller.signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const body = await response.body.text();
    const contentType = response.headers["content-type"];
    const bodyKind = classifyBody(
      Array.isArray(contentType) ? contentType.join(",") : contentType ?? null,
      body,
    );
    return {
      ok: response.statusCode >= 200 && response.statusCode < 400 && bodyKind !== "miosa_gateway_json",
      status: response.statusCode,
      url: url.toString(),
      body_kind: bodyKind,
    };
  } catch (err) {
    return {
      ok: false,
      url: url.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHost(
  host: DockerDeployHost,
  timeoutSec: number,
): Promise<DockerDeployHost> {
  const client = createClient();
  const deadline = Date.now() + timeoutSec * 1000;
  let current = host;

  while (!hostReady(current) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const raw = await client.apiGet<unknown>(
      `/api/v1/docker-deploy/hosts/${encodeURIComponent(host.id)}`,
    );
    current = objectOf<DockerDeployHost>(raw, ["host"]);
  }

  return current;
}

export function register(program: Command): void {
  const root = program
    .command("docker-deploy")
    .alias("docker")
    .description("Manage MIOSA App Engine appliance hosts");

  root
    .command("hosts")
    .alias("list")
    .description("List App Engine appliance hosts")
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
        console.log(`${chalk.bold(String(hosts.length))} App Engine host(s)`);
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
    .description("List App Engine starter templates")
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
        console.log(`${chalk.bold(String(templates.length))} App Engine template(s)`);
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
    .description("Show one App Engine starter template")
    .argument("<template-id>", "App Engine template ID")
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
    .description("Provision or return the workspace App Engine host")
    .option("--workspace <id>", "Workspace ID")
    .option("--external-workspace <id>", "External workspace/customer ID")
    .option("--wait", "Wait until the appliance is active and healthy")
    .option("--timeout <seconds>", "Wait timeout in seconds", parsePositiveInt, 600)
    .option("--json", "Output raw JSON")
    .action(async (opts: {
      workspace?: string;
      externalWorkspace?: string;
      wait?: boolean;
      timeout: number;
      json?: boolean;
    }) => {
      try {
        const client = createClient();
        const raw = await client.apiPost<unknown>("/api/v1/docker-deploy/hosts/ensure", {
          ...(opts.workspace ? { workspace_id: opts.workspace } : {}),
          ...(opts.externalWorkspace ? { external_workspace_id: opts.externalWorkspace } : {}),
        });
        let host = objectOf<DockerDeployHost>(raw, ["host"]);
        if (opts.wait) host = await waitForHost(host, opts.timeout);

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
    .description("Show one App Engine appliance host")
    .argument("<host-id>", "App Engine host ID")
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
    .description("Verify a App Engine deployment, host, route, and public URL")
    .argument("<deployment-id>", "Deployment/app ID to verify")
    .option("--probe-path <path>", "HTTP path to probe on the public URL", "/")
    .option("--timeout <seconds>", "Public probe timeout in seconds", parsePositiveInt, 20)
    .option("--no-probe", "Skip the public HTTP probe")
    .option("--json", "Output raw JSON")
    .action(async (
      deploymentId: string,
      opts: { probePath: string; timeout: number; probe?: boolean; json?: boolean },
    ) => {
      try {
        const client = createClient();
        const deployment = objectOf<Record<string, unknown>>(
          await client.apiGet<unknown>(
            `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
          ),
          ["deployment"],
        ) as unknown as Deployment;
        const product = deploymentProduct(deployment);
        const app = deploymentDockerDeployApp(deployment);
        const hostId = deploymentHostId(deployment);
        const runtime = deploymentRuntime(deployment);
        const publicUrl = deploymentPublicUrl(deployment);
        let host: DockerDeployHost | null = null;

        if (hostId) {
          host = objectOf<DockerDeployHost>(
            await client.apiGet<unknown>(
              `/api/v1/docker-deploy/hosts/${encodeURIComponent(hostId)}`,
            ),
            ["host"],
          );
        }

        const probe =
          opts.probe === false
            ? null
            : await probeUrl(publicUrl, opts.probePath, opts.timeout * 1000);

        const checks: DockerDeployCheck[] = [
          {
            id: "deployment_product",
            ok: product === "docker_deploy",
            message:
              product === "docker_deploy"
                ? "Deployment is marked docker_deploy."
                : `Deployment product is ${product}; expected docker_deploy.`,
            recovery: ["Publish with --docker-deploy or inspect deployment metadata."],
          },
          {
            id: "host_linked",
            ok: Boolean(hostId),
            message: hostId
              ? `Deployment links to App Engine host ${hostId}.`
              : "Deployment has no App Engine host id.",
            recovery: ["Run miosa docker-deploy ensure --wait --json."],
          },
          {
            id: "host_ready",
            ok: Boolean(host && hostReady(host)),
            message: host
              ? `Host status=${host.status}, appliance=${host.appliance_status ?? "unknown"}.`
              : "App Engine host could not be loaded.",
            recovery: hostId
              ? [`miosa docker-deploy show ${hostId} --json`, `miosa docker-deploy ensure --wait --json`]
              : ["miosa docker-deploy ensure --wait --json"],
          },
          {
            id: "appliance_route",
            ok: Boolean(runtime.ip && runtime.port),
            message: runtime.ip && runtime.port
              ? `Route points to ${runtime.ip}:${runtime.port}.`
              : "Deployment runtime route is missing ip/port metadata.",
            recovery: ["Re-publish with miosa sandbox publish --docker-deploy --wait --json."],
          },
          {
            id: "app_truth_row",
            ok: Boolean(app),
            message: app
              ? `App Engine app row exists with status=${app.status ?? "unknown"}.`
              : "Deployment has no App Engine app row.",
            recovery: ["Re-publish with --docker-deploy --wait, then re-run doctor."],
          },
          {
            id: "app_container_running",
            ok: Boolean(
              app &&
                app.status === "running" &&
                stringField(app, "container_id") &&
                numberField(app, "runtime_port") &&
                stringField(app, "runtime_ip"),
            ),
            message: app
              ? `App status=${app.status ?? "unknown"}, container=${app.container_id ?? "missing"}, route=${app.runtime_ip ?? "missing"}:${app.runtime_port ?? "missing"}.`
              : "Cannot verify app container because the app row is missing.",
            recovery: [
              "Check the appliance container list.",
              "Re-run miosa docker-deploy doctor <deployment-id> --json after the publish job completes.",
            ],
          },
        ];

        if (probe) {
          checks.push({
            id: "public_probe",
            ok: probe.ok,
            message: probe.ok
              ? `Public URL returned HTTP ${probe.status}.`
              : `Public URL did not return a healthy app response: ${probe.error ?? `HTTP ${probe.status}, body=${probe.body_kind}`}.`,
            recovery: [
              "Check miosa deploy show <deployment-id> --json.",
              "Check miosa docker-deploy show <host-id> --json.",
              "Re-run miosa sandbox publish <sandbox-id> --docker-deploy --wait --json if the app container is gone.",
            ],
          });
        }

        const result = {
          ok: checks.every((check) => check.ok),
          deployment_id: deployment.id ?? deploymentId,
          deployment_product: product,
          docker_deploy_host_id: hostId,
          host_ready: Boolean(host && hostReady(host)),
          docker_deploy_app: app,
          route: runtime,
          public_url: publicUrl,
          public_probe: probe,
          checks,
        };

        if (!result.ok) process.exitCode = 1;

        if (isJsonMode(opts) || opts.json) {
          printJson(result);
          return;
        }

        console.log();
        console.log(chalk.bold("App Engine doctor"));
        console.log();
        console.log(`  Deployment: ${result.deployment_id}`);
        console.log(`  Product:    ${result.deployment_product}`);
        console.log(`  Host:       ${result.docker_deploy_host_id ?? "—"}`);
        console.log(`  Container:  ${app?.container_id ?? "—"}`);
        console.log(`  Route:      ${runtime.ip && runtime.port ? `${runtime.ip}:${runtime.port}` : "—"}`);
        console.log(`  URL:        ${result.public_url ?? "—"}`);
        console.log();
        for (const check of checks) {
          console.log(`  ${check.ok ? chalk.green("✓") : chalk.red("✗")} ${check.id}: ${check.message}`);
        }
        console.log();
      } catch (err) {
        handleError(err);
      }
    });
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}
