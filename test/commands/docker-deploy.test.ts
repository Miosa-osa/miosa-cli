import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
  saveConfig: vi.fn(),
}));

const { register } = await import("../../src/commands/docker-deploy.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function captureLogs(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  return logged;
}

const host = {
  id: "ddh-0000-0000-0000-000000000001",
  tenant_id: "ten-0000-0000-0000-000000000001",
  workspace_id: "ws-0000-0000-0000-000000000001",
  external_workspace_id: "dr-smith",
  computer_id: "comp-0000-0000-0000-000000000001",
  status: "bootstrapping",
  size: "medium",
  region: "us",
  portal_domain: "dr-smith.deploy.miosa.ai",
  runtime_base_url: "http://10.0.0.12:3000",
  agent_base_url: "http://10.0.0.12:8090",
  appliance_status: "starting",
  updated_at: "2026-06-09T00:00:00Z",
};

const readyHost = {
  ...host,
  status: "active",
  appliance_status: "healthy",
};

const template = {
  id: "compose-full-stack",
  name: "Compose full stack",
  description: "Web, API, worker, Postgres, and Redis",
  category: "compose",
  runtime: "docker-compose",
  tags: ["compose", "postgres", "redis"],
};

describe("miosa docker-deploy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("lists Docker Deploy hosts by workspace", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/hosts?workspace_id=ws_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [host] }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "hosts",
      "--workspace",
      "ws_123",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("App Engine host");
    expect(output).toContain("dr-smith.deploy.miosa.ai");
  });

  it("ensures a Docker Deploy host", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ensure",
        method: "POST",
        body: JSON.stringify({ workspace_id: "ws_123" }),
      })
      .reply(201, JSON.stringify({ host, queued: true }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "ensure",
      "--workspace",
      "ws_123",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("App Engine host");
    expect(output).toContain("Appliance:");
    expect(output).toContain("starting");
  });

  it("waits for an ensured Docker Deploy host to become healthy", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ensure",
        method: "POST",
        body: JSON.stringify({ workspace_id: "ws_123" }),
      })
      .reply(201, JSON.stringify({ host, queued: true }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/docker-deploy/hosts/${host.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ host: readyHost }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "ensure",
      "--workspace",
      "ws_123",
      "--wait",
      "--timeout",
      "10",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as typeof host;
    expect(parsed.status).toBe("active");
    expect(parsed.appliance_status).toBe("healthy");
  });

  it("queues an in-place upgrade with exact immutable portal and agent images", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const release = "sha-3eedafc";
    const upgradingHost = {
      ...host,
      appliance_status: "needs_reconcile",
      appliance_version: release,
    };

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/docker-deploy/hosts/${host.id}/upgrade`,
        method: "POST",
        body: JSON.stringify({
          appliance_image: `ghcr.io/miosa-osa/docker-deploy-appliance:${release}`,
          agent_image: `ghcr.io/miosa-osa/docker-deploy-appliance-agent:${release}`,
          appliance_version: release,
        }),
      })
      .reply(202, JSON.stringify({ host: upgradingHost, queued: true }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "upgrade",
      host.id,
      "--release",
      "3eedafc",
      "--no-wait",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.release).toBe(release);
    expect(parsed.host.appliance_status).toBe("needs_reconcile");
  });

  it("lists Docker Deploy templates", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/templates",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [template] }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "docker-deploy", "templates"]);

    const output = logged.join("\n");
    expect(output).toContain("App Engine template");
    expect(output).toContain("compose-full-stack");
  });

  it("shows a Docker Deploy template", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/templates/compose-full-stack",
        method: "GET",
      })
      .reply(200, JSON.stringify({ template }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "template",
      "compose-full-stack",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("Compose full stack");
    expect(output).toContain("docker-compose");
  });

  it("doctors a Docker Deploy deployment route and public URL", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const deployment = {
      id: "dep_123",
      name: "docker-site",
      slug: "docker-site",
      state: "running",
      deployment_product: "docker_deploy",
      active_version_id: "version_123",
      docker_deploy_host_id: readyHost.id,
      public_url: "https://docker-site.example.com",
      metadata: {
        deployment_product: "docker_deploy",
        runtime: {
          ip: "172.16.74.200",
          port: 20000,
        },
        docker_deploy: {
          host_id: readyHost.id,
          status: "running",
        },
      },
      docker_deploy_app: {
        id: "app_row_123",
        docker_deploy_host_id: readyHost.id,
        app_id: "dokploy_app_123",
        container_id: "container_123",
        status: "running",
        runtime_ip: "172.16.74.246",
        runtime_port: 23906,
        public_url: "https://docker-site.example.com",
        last_health_status: "healthy",
        deployment_version_id: "version_123",
      },
    };

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/docker-deploy/hosts/${readyHost.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ host: readyHost }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://docker-site.example.com")
      .intercept({ path: "/health", method: "GET" })
      .reply(200, "<!doctype html><title>ok</title>", {
        headers: { "content-type": "text/html" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "doctor",
      "dep_123",
      "--probe-path",
      "/health",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      deployment_product: string;
      host_ready: boolean;
      docker_deploy_app: { container_id: string; status: string };
      route: { ip: string; port: number };
      public_probe: { ok: boolean; status: number; body_kind: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.deployment_product).toBe("docker_deploy");
    expect(parsed.host_ready).toBe(true);
    expect(parsed.docker_deploy_app).toMatchObject({
      container_id: "container_123",
      status: "running",
    });
    expect(parsed.route).toEqual({ ip: "172.16.74.246", port: 23906 });
    expect(parsed.public_probe).toMatchObject({
      ok: true,
      status: 200,
      body_kind: "html",
    });
    expect(parsed).toMatchObject({ ok: true });
  });

  it("fails doctor when a Docker Deploy deployment has no app truth row", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const deployment = {
      id: "dep_no_app",
      name: "docker-site",
      slug: "docker-site",
      state: "running",
      deployment_product: "docker_deploy",
      docker_deploy_host_id: readyHost.id,
      public_url: "https://docker-site.example.com",
      metadata: {
        deployment_product: "docker_deploy",
        runtime: {
          ip: "172.16.74.246",
          port: 23906,
        },
      },
      docker_deploy_app: null,
    };

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_no_app",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/docker-deploy/hosts/${readyHost.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ host: readyHost }), {
        headers: { "content-type": "application/json" },
      });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "doctor",
      "dep_no_app",
      "--no-probe",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "app_truth_row", ok: false }),
    );
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "app_container_running", ok: false }),
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });

  it("fails doctor when promotion metadata and the serving container disagree", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const deployment = {
      id: "dep_version_skew",
      name: "docker-site",
      slug: "docker-site",
      state: "running",
      deployment_product: "docker_deploy",
      active_version_id: "version_new",
      docker_deploy_host_id: readyHost.id,
      public_url: "https://docker-site.example.com",
      metadata: {
        deployment_product: "docker_deploy",
        runtime: { ip: "172.16.74.246", port: 23906 },
      },
      docker_deploy_app: {
        id: "app_row_123",
        docker_deploy_host_id: readyHost.id,
        container_id: "container_old",
        status: "running",
        runtime_ip: "172.16.74.246",
        runtime_port: 23906,
        deployment_version_id: "version_old",
      },
    };

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/deployments/dep_version_skew", method: "GET" })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/docker-deploy/hosts/${readyHost.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ host: readyHost }), {
        headers: { "content-type": "application/json" },
      });

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "docker-deploy",
      "doctor",
      "dep_version_skew",
      "--no-probe",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; message: string }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        id: "version_reconciled",
        ok: false,
        message: expect.stringContaining("active=version_new, serving=version_old"),
      }),
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = previousExitCode;
  });
});
