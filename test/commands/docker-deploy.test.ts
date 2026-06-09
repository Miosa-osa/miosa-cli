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
});
