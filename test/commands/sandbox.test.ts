import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const { register } = await import("../../src/commands/sandbox.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa sandbox exec", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors --cwd even when the API only executes the command string", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      command: "cd '/workspace' && pwd",
      cwd: "/workspace",
      dir: "/workspace",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({ data: { exit_code: 0, stdout: "/workspace\n" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "--cwd",
      "/workspace",
      "pwd",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("creates a durable command for detached exec with workdir and env", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      command: "npm run dev",
      cwd: "/workspace",
      env: { NODE_ENV: "development" },
      sudo: false,
      tty: false,
      interactive: false,
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/commands",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "cmd_123", status: "running" } }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "--detached",
      "--workdir",
      "/workspace",
      "--env",
      "NODE_ENV=development",
      "npm run dev",
    ]);

    expect(console.log).toHaveBeenCalledWith("cmd_123");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("updates nested deployment state after publish --wait", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const initial = {
      deployment_id: "dep_123",
      version_id: "ver_123",
      release_id: "rel_123",
      url: "https://clinic-app.cliniciq.com",
      state: "building",
      data: {
        deployment: {
          id: "dep_123",
          state: "building",
          active_version_id: null,
          public_url: "https://clinic-app.cliniciq.com",
        },
        version: { id: "ver_123" },
        release: { id: "rel_123" },
      },
    };

    const readyDeployment = {
      id: "dep_123",
      state: "running",
      active_version_id: "ver_123",
      public_url: "https://clinic-app.cliniciq.com",
    };

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/publish",
        method: "POST",
      })
      .reply(201, JSON.stringify(initial), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: readyDeployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://clinic-app.cliniciq.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "ok");

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "publish",
      "sbx_123",
      "--run-command",
      "npm start",
      "--wait",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.state).toBe("running");
    expect(parsed.ready).toBe(true);
    expect(parsed.data.deployment.state).toBe("running");
    expect(parsed.data.deployment.active_version_id).toBe("ver_123");
    expect(parsed.data.app_consistency_pending).toBe(false);
  });
});
