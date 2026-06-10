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
    expect(output).toContain("Docker Deploy host");
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
    expect(output).toContain("Docker Deploy host");
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
    expect(output).toContain("Docker Deploy template");
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
      docker_deploy_host_id: readyHost.id,
      public_url: "https://docker-site.example.com",
      metadata: {
        deployment_product: "docker_deploy",
        runtime: {
          ip: "172.16.74.246",
          port: 23906,
        },
        docker_deploy: {
          host_id: readyHost.id,
          status: "running",
        },
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
      route: { ip: string; port: number };
      public_probe: { ok: boolean; status: number; body_kind: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.deployment_product).toBe("docker_deploy");
    expect(parsed.host_ready).toBe(true);
    expect(parsed.route).toEqual({ ip: "172.16.74.246", port: 23906 });
    expect(parsed.public_probe).toMatchObject({
      ok: true,
      status: 200,
      body_kind: "html",
    });
  });
});
