import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  it("explains destroyed sandbox exec failures with a replacement command", async () => {
    const oldJsonMode = process.env["MIOSA_JSON"];
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_destroyed/exec",
        method: "POST",
      })
      .reply(
        409,
        JSON.stringify({
          error: {
            code: "SANDBOX_NOT_RUNNING",
            message: "sandbox must be in running state to exec",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_destroyed",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "sbx_destroyed",
            name: "bennett-os-auth-db",
            template_id: "nextjs",
            state: "destroyed",
            timeout_sec: 900,
            timeout_remaining_ms: 0,
            destroyed_at: "2026-06-12T19:00:00Z",
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
      "exec",
      "sbx_destroyed",
      "--json",
      "--",
      "pwd",
    ]);

    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.error.code).toBe("SANDBOX_NOT_RUNNING");
    expect(parsed.error.message).toContain("destroyed, not paused");
    expect(parsed.error.hint).toContain(
      "miosa sandbox create --template nextjs --name 'bennett-os-auth-db' --timeout 1h",
    );
    expect(process.exit).toHaveBeenCalledWith(1);

    if (oldJsonMode === undefined) {
      delete process.env["MIOSA_JSON"];
    } else {
      process.env["MIOSA_JSON"] = oldJsonMode;
    }
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

  it("uses a one-hour default timeout and surfaces boot last_error during create --wait", async () => {
    const oldJsonMode = process.env["MIOSA_JSON"];
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "nextjs",
          name: "bennett-os-auth-db",
          timeout_sec: 3600,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "sbx_error",
            name: "bennett-os-auth-db",
            template_id: "nextjs",
            state: "provisioning",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_error",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "sbx_error",
            name: "bennett-os-auth-db",
            template_id: "nextjs",
            state: "error",
            metadata: {
              last_error: {
                reason:
                  '{:workspace_prepare_failed, {401, "{\\"error\\":\\"unauthorized\\"}\\n"}}',
              },
            },
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
      "create",
      "--template",
      "nextjs",
      "--name",
      "bennett-os-auth-db",
      "--wait",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.error.code).toBe("USER");
    expect(parsed.error.message).toContain("workspace_prepare_failed");
    expect(parsed.error.message).toContain("unauthorized");
    expect(parsed.error.hint).toContain("miosa sandbox recover sbx_error");
    expect(process.exit).toHaveBeenCalledWith(1);

    if (oldJsonMode === undefined) {
      delete process.env["MIOSA_JSON"];
    } else {
      process.env["MIOSA_JSON"] = oldJsonMode;
    }
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

  it("publishes sandbox workspaces through Docker Deploy", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/publish",
        method: "POST",
        body: JSON.stringify({
          output_path: "/workspace",
          path: "/workspace",
          environment: "production",
          metadata: {
            environment: "production",
            deployment_product: "docker_deploy",
          },
          deployment_type: "docker-deploy",
          name: "docker-site",
          run_command: "npm start",
          port: 3000,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          deployment_id: "dep_123",
          version_id: "ver_123",
          release_id: "rel_123",
          url: "https://docker-site.example.com",
          state: "building",
          deployment_product: "docker_deploy",
          data: {
            deployment: {
              id: "dep_123",
              state: "building",
              docker_deploy_host_id: "ddh_123",
              metadata: { deployment_product: "docker_deploy" },
            },
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
      "publish",
      "sbx_123",
      "--name",
      "docker-site",
      "--run-command",
      "npm start",
      "--port",
      "3000",
      "--docker-deploy",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n")) as Record<string, unknown>;
    expect(parsed["deployment_product"]).toBe("docker_deploy");
    expect(parsed["docker_deploy_host_id"]).toBe("ddh_123");
  });

  it("falls back to chunked exec upload when sandbox file transport returns 502", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-upload-fallback-"));
    const file = path.join(dir, "payload.txt");
    fs.writeFileSync(file, "hello from fallback");

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files",
        method: "POST",
      })
      .reply(
        502,
        JSON.stringify({
          error: {
            code: "SANDBOX_FILE_AGENT_UNAVAILABLE",
            message: "Sandbox file transport is unavailable",
            retryable: true,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    for (let i = 0; i < 3; i += 1) {
      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: "/api/v1/sandboxes/sbx_123/exec",
          method: "POST",
        })
        .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "" } }), {
          headers: { "content-type": "application/json" },
        });
    }

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "upload",
      "sbx_123",
      file,
      "/workspace/payload.txt",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      data: {
        sandbox_id: "sbx_123",
        path: "/workspace/payload.txt",
        size: 19,
        transport: "exec_chunked_fallback",
      },
    });
  });

  it("returns partial sandbox metadata when deploy fails after sandbox creation", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-deploy-partial-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "node server.js" } }),
    );
    fs.writeFileSync(path.join(dir, "server.js"), "console.log('ok');\n");

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
      })
      .reply(201, JSON.stringify({ data: { id: "sbx_partial" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_partial",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_partial", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_partial/files",
        method: "POST",
      })
      .reply(
        502,
        JSON.stringify({
          error: {
            code: "SANDBOX_FILE_AGENT_UNAVAILABLE",
            message: "Sandbox file transport is unavailable",
            retryable: true,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_partial/exec",
        method: "POST",
      })
      .reply(
        502,
        JSON.stringify({
          error: {
            code: "SANDBOX_FILE_AGENT_UNAVAILABLE",
            message: "Sandbox exec transport is unavailable",
            retryable: true,
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
      "deploy",
      dir,
      "--name",
      "bennett-os-marketing",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.ok).toBe(false);
    expect(parsed.partial_resource).toMatchObject({
      type: "sandbox",
      id: "sbx_partial",
    });
    expect(parsed.partial_resource.recovery_command).toContain(
      "--sandbox 'sbx_partial'",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("starts services through the service up alias", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/services",
        method: "POST",
        body: JSON.stringify({
          name: "next",
          command: "npm run dev -- --hostname 0.0.0.0 --port 3000",
          cwd: "/workspace",
        }),
      })
      .reply(201, JSON.stringify({ data: { status: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/expose",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { url: "https://3000-sbx.sandbox.miosa.app" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "service",
      "up",
      "sbx_123",
      "next",
      "--cwd",
      "/workspace",
      "--port",
      "3000",
      "--cmd",
      "npm run dev -- --hostname 0.0.0.0 --port 3000",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      status: "running",
      port: 3000,
      preview_url: "https://3000-sbx.sandbox.miosa.app",
    });
  });

  it("recovers a partial Next.js sandbox by name with concrete commands", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/bennett-os-marketing-v2",
        method: "GET",
      })
      .reply(404, JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "41026070-9bb0-4d62-90b4-8ceeb0a131b6",
              name: "bennett-os-marketing-v2",
              template_id: "nextjs",
              state: "running",
              ready: false,
              created_at: "2026-06-13T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/41026070-9bb0-4d62-90b4-8ceeb0a131b6/exec",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "/\n" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/41026070-9bb0-4d62-90b4-8ceeb0a131b6",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/41026070-9bb0-4d62-90b4-8ceeb0a131b6/exec",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { exit_code: 1, stdout: "refused" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/41026070-9bb0-4d62-90b4-8ceeb0a131b6/expose",
        method: "POST",
      })
      .reply(
        200,
        JSON.stringify({ data: { url: "https://3000-41026070.sandbox.miosa.app" } }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://3000-41026070.sandbox.miosa.app")
      .intercept({ path: "/", method: "GET" })
      .reply(503, "not ready");

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "recover",
      "bennett-os-marketing-v2",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.sandbox_id).toBe("41026070-9bb0-4d62-90b4-8ceeb0a131b6");
    expect(parsed.matched_by).toBe("name");
    expect(parsed.exec_ok).toBe(true);
    expect(parsed.app_port).toBe(3000);
    expect(parsed.commands.start).toContain("sandbox service up");
    expect(parsed.commands.publish).toContain("sandbox publish");
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
