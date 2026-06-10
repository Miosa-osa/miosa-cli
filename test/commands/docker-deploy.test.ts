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
    process.exitCode = undefined;
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

  it("doctors a Docker Deploy deployment", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "dep_123",
            tenant_id: "ten_123",
            owner_id: "usr_123",
            name: "Clinic Intake",
            slug: "clinic-intake",
            repo_url: "",
            repo_provider: "github",
            branch: "main",
            build_command: null,
            run_command: "npm start",
            runtime_image: null,
            current_build_id: null,
            state: "running",
            auto_deploy: true,
            custom_domain_id: null,
            deployment_product: "docker_deploy",
            docker_deploy_host_id: "ddh_123",
            public_url: "https://clinic-intake.osa.miosa.app",
            metadata: {
              deployment_product: "docker_deploy",
              runtime: { ip: "172.16.74.246", port: 23906 },
              docker_deploy: {
                app_id: "miosa-clinic-intake",
                container_id: "container_123",
                status: "running",
                url: "http://127.0.0.1:23906",
              },
            },
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-10T00:00:00Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ddh_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { ...host, id: "ddh_123", status: "active", appliance_status: "healthy" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://clinic-intake.osa.miosa.app")
      .intercept({
        path: "/health",
        method: "GET",
      })
      .reply(200, "ok");

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
    ]);

    const output = logged.join("\n");
    expect(output).toContain("Docker Deploy doctor");
    expect(output).toContain("deployment_product");
    expect(output).toContain("docker_deploy_app");
    expect(output).toContain("public_url_probe");
    expect(process.exitCode).toBeUndefined();
  });

  it("fails doctor when route points at a non-Docker runtime port", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "dep_123",
            tenant_id: "ten_123",
            owner_id: "usr_123",
            name: "Clinic Intake",
            slug: "clinic-intake",
            repo_url: "",
            repo_provider: "github",
            branch: "main",
            build_command: null,
            run_command: "npm start",
            runtime_image: null,
            current_build_id: null,
            state: "running",
            auto_deploy: true,
            custom_domain_id: null,
            deployment_product: "docker_deploy",
            docker_deploy_host_id: "ddh_123",
            public_url: "https://clinic-intake.osa.miosa.app",
            metadata: {
              deployment_product: "docker_deploy",
              runtime: { ip: "172.16.74.246", port: 8080 },
              docker_deploy: {
                app_id: "miosa-clinic-intake",
                container_id: "container_123",
                status: "running",
                url: "http://127.0.0.1:23906",
              },
            },
            created_at: "2026-06-10T00:00:00Z",
            updated_at: "2026-06-10T00:00:00Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ddh_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { ...host, id: "ddh_123", status: "active", appliance_status: "healthy" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://clinic-intake.osa.miosa.app")
      .intercept({
        path: "/health",
        method: "GET",
      })
      .reply(200, "ok");

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

    const result = JSON.parse(logged.join("\n"));
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runtime_route",
          ok: false,
          message: "Deployment route port 8080 does not match Docker container host port 23906.",
        }),
      ]),
    );
    expect(process.exitCode).toBe(1);
  });
});
