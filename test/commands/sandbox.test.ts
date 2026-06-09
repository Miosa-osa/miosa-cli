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

  it("passes through unknown flags and preserves quoting for bash -c", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // bash -c "cd x && y" arrives as argv words; the multi-word arg must be
    // re-quoted so the shell command survives intact.
    const expectedBody = JSON.stringify({
      command: "bash -c 'cd /tmp && echo hi'",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
        body: expectedBody,
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "hi\n" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "bash",
      "-c",
      "cd /tmp && echo hi",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("supports --cmd and --shell-cmd for parser-safe shell execution", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      command: "bash -lc 'cd /workspace && npm install'",
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
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "ok\n" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "--cwd",
      "/workspace",
      "--cmd",
      "cd /workspace && npm install",
      "--shell-cmd",
      "bash -lc",
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

describe("miosa sandbox env", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets encrypted sandbox env vars through the API", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/env",
        method: "PUT",
        body: JSON.stringify({
          vars: [{ key: "APP_SECRET", value: "supersecret" }],
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ name: "APP_SECRET", preview: "sup...ret" }],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "env",
      "set",
      "sbx_123",
      "APP_SECRET=supersecret",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Array<
      Record<string, unknown>
    >;
    expect(parsed[0]?.["name"]).toBe("APP_SECRET");
  });

  it("syncs sandbox env vars into the running VM", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/env/sync",
        method: "POST",
        body: JSON.stringify({}),
      })
      .reply(
        200,
        JSON.stringify({
          data: { status: "synced", env_keys: ["APP_SECRET"] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "env",
      "sync",
      "sbx_123",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["status"]).toBe("synced");
  });
});

describe("miosa sandbox observability", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists backend-detected listening ports as JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/ports",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          sandbox_id: "sbx_123",
          count: 1,
          ports: [
            {
              protocol: "tcp",
              state: "listen",
              address: "0.0.0.0",
              port: 3000,
              process: { name: "next-server", pid: 123 },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "ports",
      "sbx_123",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["count"]).toBe(1);
    expect(parsed["ports"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ port: 3000 })]),
    );
  });

  it("fetches sandbox metrics from the backend endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/metrics?window=24h",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          resource_type: "sandbox",
          sandbox_id: "sbx_123",
          window: "24h",
          current: {
            state: "running",
            ready: true,
            cpu_count: 2,
            memory_mb: 2048,
          },
          series: { cpu_percent: [], memory_mb: [] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "metrics",
      "sbx_123",
      "--window",
      "24h",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["resource_type"]).toBe("sandbox");
    expect(parsed["current"]).toEqual(
      expect.objectContaining({ state: "running", ready: true }),
    );
  });
});

describe("miosa sandbox db", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches a database to sandbox encrypted env", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/database",
        method: "POST",
        body: JSON.stringify({ database_id: "db_123" }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            attached: true,
            sandbox_id: "sbx_123",
            database_id: "db_123",
            env_vars: [{ name: "DATABASE_URL", preview: "pos...app" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "db",
      "attach",
      "sbx_123",
      "db_123",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["attached"]).toBe(true);
    expect(parsed["database_id"]).toBe("db_123");
  });
});
