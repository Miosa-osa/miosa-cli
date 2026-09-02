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
    tenant: "panther-defense",
    workspace: "panther-workspace",
  }),
}));

const { buildSandboxWebSocketRequest, register } = await import(
  "../../src/commands/sandbox.js"
);

const originalJsonMode = process.env["MIOSA_JSON"];
const originalExitCode = process.exitCode;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

/** Case-insensitive header lookup for undici MockAgent reply callbacks. */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
    }
  }
  return undefined;
}

function mockSandboxSshKey(): void {
  const existsSync = fs.existsSync.bind(fs);
  const readFileSync = fs.readFileSync.bind(fs);
  vi.spyOn(fs, "existsSync").mockImplementation((file) =>
    String(file).endsWith("miosa_sandbox_ed25519")
      ? true
      : existsSync(file),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) =>
    String(file).endsWith("miosa_sandbox_ed25519.pub")
      ? "ssh-ed25519 AAAATEST panther@test\n"
      : readFileSync(file, options as never),
  );
}

describe("miosa sandbox exec", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalJsonMode === undefined) {
      delete process.env["MIOSA_JSON"];
    } else {
      process.env["MIOSA_JSON"] = originalJsonMode;
    }
    // exec now sets process.exitCode on a nonzero remote exit; reset it so a
    // failing-command test does not leak a nonzero status to the vitest runner.
    process.exitCode = originalExitCode;
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

  it("sends --env values under the `env` body field the backend honors", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // The backend reads env from the body key `env` and applies it to the
    // guest via `sh -c`; the CLI must therefore send it there.
    const expectedBody = JSON.stringify({
      command: "echo hi",
      env: { FOO: "bar", BAZ: "qux" },
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
      "--cmd",
      "echo hi",
      "--env",
      "FOO=bar",
      "--env",
      "BAZ=qux",
    ]);

    // An empty pending list proves the body (including env) matched exactly.
    expect(mock.pendingInterceptors()).toEqual([]);
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("sets process.exitCode to a nonzero remote exit_code", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
      })
      .reply(
        200,
        JSON.stringify({ data: { exit_code: 7, stdout: "", stderr: "boom\n" } }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "--cmd",
      "exit 7",
    ]);

    // A remote failure must fail the CLI process so CI/`&&` chains detect it.
    expect(process.exitCode).toBe(7);
  });

  it("downloads raw sandbox files without parsing them as JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-cli-sandbox-"));
    const output = path.join(tmpDir, "index.html");

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files/workspace%2Findex.html",
        method: "GET",
      })
      .reply(200, "<html><body>file</body></html>", {
        headers: { "content-type": "text/html" },
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
      "download",
      "sbx_123",
      "/workspace/index.html",
      "--output",
      output,
      "--json",
    ]);

    expect(fs.readFileSync(output, "utf8")).toBe(
      "<html><body>file</body></html>",
    );
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      sandbox_id: "sbx_123",
      remote_path: "/workspace/index.html",
      output,
      bytes: 30,
    });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("reads sandbox files in the explicit Panther tenant and workspace", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_panther/files/read?path=%2Fworkspace%2Fstatus.txt",
        method: "GET",
        headers: {
          "x-miosa-tenant": "panther-defense",
          "x-miosa-workspace": "panther-workspace",
        },
      })
      .reply(200, JSON.stringify({ data: { content: "ready" } }), {
        headers: { "content-type": "application/json" },
      });

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "read-file",
      "sbx_panther",
      "/workspace/status.txt",
    ]);

    expect(output.join("")).toBe("ready");
    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("fails closed when Panther sandbox scope is rejected", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_osa/files/read?path=%2Fworkspace%2Fsecret.txt",
        method: "GET",
        headers: {
          "x-miosa-tenant": "panther-defense",
          "x-miosa-workspace": "panther-workspace",
        },
      })
      .reply(
        403,
        JSON.stringify({
          error: {
            code: "INVALID_TENANT_CONTEXT",
            message: "credential is not authorized for Panther",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_osa/files/read?path=%2Fworkspace%2Fsecret.txt",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { content: "osa-secret" } }), {
        headers: { "content-type": "application/json" },
      });
    setGlobalDispatcher(mock);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "read-file",
      "sbx_osa",
      "/workspace/secret.txt",
    ]);

    expect(process.exit).toHaveBeenCalledWith(3);
    expect(mock.pendingInterceptors()).toHaveLength(1);
  });

  it("constructs scoped Panther SSH registration and WebSocket requests", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_panther/ssh-keys",
        method: "POST",
        headers: {
          "x-miosa-tenant": "panther-defense",
          "x-miosa-workspace": "panther-workspace",
        },
        body: JSON.stringify({
          public_key: "ssh-ed25519 AAAATEST panther@test",
        }),
      })
      .reply(204);

    mockSandboxSshKey();

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "ssh",
      "sbx_panther",
      "--json",
    ]);

    const result = JSON.parse(output.at(-1) ?? "{}") as { ws_url?: string };
    const wsUrl = new URL(result.ws_url ?? "");
    expect(wsUrl.searchParams.get("tenant")).toBe("panther-defense");
    expect(wsUrl.searchParams.get("workspace")).toBe("panther-workspace");
    expect(
      buildSandboxWebSocketRequest(
        {
          endpoint: "https://api.miosa.ai",
          api_key: "msk_u_test" as never,
          default_host: null,
          tenant: "panther-defense",
          workspace: "panther-workspace",
        },
        "sbx_panther",
      ).headers,
    ).toMatchObject({
      Authorization: "Bearer msk_u_test",
      "X-MIOSA-Tenant": "panther-defense",
      "X-MIOSA-Workspace": "panther-workspace",
    });
    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("fails closed when scoped Panther SSH registration is rejected", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_osa/ssh-keys",
        method: "POST",
        headers: {
          "x-miosa-tenant": "panther-defense",
          "x-miosa-workspace": "panther-workspace",
        },
      })
      .reply(
        403,
        JSON.stringify({
          error: {
            code: "INVALID_TENANT_CONTEXT",
            message: "credential is not authorized for Panther",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_osa/ssh-keys",
        method: "POST",
      })
      .reply(204);
    setGlobalDispatcher(mock);

    mockSandboxSshKey();

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "ssh",
      "sbx_osa",
      "--json",
    ]);

    expect(process.exit).toHaveBeenCalledWith(3);
    expect(mock.pendingInterceptors()).toHaveLength(1);
  });

  it("creates and downloads sandbox exports through the release/v1 routes", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-cli-export-"));
    const output = path.join(tmpDir, "export.tar");

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exports",
        method: "POST",
        body: JSON.stringify({
          paths: ["/workspace/report.html", "/workspace/assets"],
          label: "Agent files",
          filename: "agent-files.tar",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "exp_123",
            sandbox_id: "sbx_123",
            status: "ready",
            filename: "agent-files.tar",
            archive_download_url:
              "/api/v1/sandboxes/sbx_123/exports/download?paths%5B%5D=%2Fworkspace%2Freport.html&paths%5B%5D=%2Fworkspace%2Fassets&filename=agent-files.tar",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exports/download?paths%5B%5D=%2Fworkspace%2Freport.html&paths%5B%5D=%2Fworkspace%2Fassets&filename=agent-files.tar",
        method: "GET",
      })
      .reply(200, "tar-bytes", {
        headers: { "content-type": "application/x-tar" },
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
      "export",
      "sbx_123",
      "/workspace/report.html",
      "/workspace/assets",
      "--label",
      "Agent files",
      "--filename",
      "agent-files.tar",
      "--output",
      output,
      "--json",
    ]);

    expect(fs.readFileSync(output, "utf8")).toBe("tar-bytes");
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "exp_123",
      sandbox_id: "sbx_123",
      status: "ready",
      downloaded_to: output,
    });
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
          size: "small",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
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

  it("creates non-persistent sandboxes only when explicitly requested", async () => {
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
          name: "throwaway",
          size: "small",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: false,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "sbx_tmp",
            name: "throwaway",
            template_id: "nextjs",
            state: "running",
            persistent: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "nextjs",
      "--name",
      "throwaway",
      "--non-persistent",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("passes external attribution IDs in the create body when flags are set", async () => {
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
          name: "attributed",
          size: "small",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          external_workspace_id: "clinic-iq",
          external_user_id: "founder-1",
          external_project_id: "landing-page",
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "sbx_attr",
            name: "attributed",
            template_id: "nextjs",
            state: "running",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "nextjs",
      "--name",
      "attributed",
      "--external-workspace",
      "clinic-iq",
      "--external-user",
      "founder-1",
      "--external-project",
      "landing-page",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("omits external attribution fields from the create body when flags are absent", async () => {
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
          name: "unattributed",
          size: "small",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "sbx_plain",
            name: "unattributed",
            template_id: "nextjs",
            state: "running",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "nextjs",
      "--name",
      "unattributed",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("sends an auto-generated Idempotency-Key header on create", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    let capturedKey: string | undefined;
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/sandboxes", method: "POST" })
      .reply(
        201,
        (opts: { headers: unknown }) => {
          capturedKey = readHeader(opts.headers, "idempotency-key");
          return JSON.stringify({
            data: { id: "sbx_idem", state: "running" },
          });
        },
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "nextjs",
      "--json",
    ]);

    expect(capturedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("reuses the same Idempotency-Key across a 503 create retry", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const keys: (string | undefined)[] = [];
    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/sandboxes", method: "POST" })
      .reply(
        503,
        (opts: { headers: unknown }) => {
          keys.push(readHeader(opts.headers, "idempotency-key"));
          return JSON.stringify({ error: { message: "try again" } });
        },
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({ path: "/api/v1/sandboxes", method: "POST" })
      .reply(
        201,
        (opts: { headers: unknown }) => {
          keys.push(readHeader(opts.headers, "idempotency-key"));
          return JSON.stringify({
            data: { id: "sbx_retry", state: "running" },
          });
        },
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "nextjs",
      "--json",
    ]);

    expect(keys.length).toBe(2);
    expect(keys[0]).toBeTruthy();
    // The retry must re-send the SAME key or the server would create a
    // duplicate, billable sandbox.
    expect(keys[1]).toBe(keys[0]);
  });

  it("create --wait does not report success until command-ready", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/sandboxes", method: "POST" })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_cr", state: "provisioning" } }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_cr", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "sbx_cr", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    let readinessCalls = 0;
    // First readiness probe: running but command agent NOT attached.
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_cr/readiness", method: "GET" })
      .reply(
        200,
        () => {
          readinessCalls += 1;
          return JSON.stringify({
            state: "running",
            ready: false,
            readiness: {
              status: "pending",
              components: { command_agent: { status: "pending" } },
            },
          });
        },
        { headers: { "content-type": "application/json" } },
      );
    // Second readiness probe: command-ready.
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_cr/readiness", method: "GET" })
      .reply(
        200,
        () => {
          readinessCalls += 1;
          return JSON.stringify({
            state: "running",
            ready: false,
            readiness: {
              status: "ready",
              components: {
                command_agent: { status: "ready" },
                process_control: { status: "ready" },
                resource_contract: { status: "ready" },
                clock: { status: "ready" },
                identity: { status: "ready" },
                durability: { status: "ready" },
                filesystem: { status: "ready" },
                internal_probe: { status: "ready" },
              },
            },
          });
        },
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
      "--wait",
      "--json",
    ]);

    // The first (not-command-ready) probe must not resolve the wait.
    expect(readinessCalls).toBeGreaterThanOrEqual(2);
    const parsed = JSON.parse(logged.join("\n"));
    expect(parsed.id).toBe("sbx_cr");
    expect(parsed.ready).toBe(true);
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("creates a sandbox with the named small size by default", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox",
          size: "small",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_small", state: "running" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("sends an explicitly selected named sandbox size", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox",
          size: "large",
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_large", state: "running" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--size",
      "large",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("accepts a complete exact legacy resource override", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox",
          size: "medium",
          cpu_count: 4,
          memory_mb: 8192,
          disk_size_mb: 20480,
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_medium", state: "running" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--cpu",
      "4",
      "--memory",
      "8gb",
      "--disk",
      "20gb",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("combines a named size with a custom disk floor", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox",
          size: "small",
          cpu_count: 2,
          memory_mb: 4096,
          disk_size_mb: 20480,
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_small20", state: "running" } }),
        { headers: { "content-type": "application/json" } },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--size",
      "small",
      "--disk",
      "20gb",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    expect(mock.pendingInterceptors()).toHaveLength(0);
  });


  it("passes a partial custom cpu override through unchanged (memory fills from the default size)", async () => {
    // 4 vCPU / 4096 MiB (memory filled from the default "small" size) is not
    // a published pair (medium is 4 vCPU / 8192 MiB), but it is a valid
    // custom shape and must reach the server as-is -- no rejection, no
    // snapping to the nearest tier, no synthesized `size`. Disk falls back
    // to the default size's floor (small = 10240) since neither --disk nor
    // --size was given.
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox",
          cpu_count: 4,
          memory_mb: 4096,
          disk_size_mb: 10240,
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_custom", state: "running" } }),
        { headers: { "content-type": "application/json" } },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--cpu",
      "4",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    expect(mock.pendingInterceptors()).toHaveLength(0);
  });

  it("passes HackerAI's off-tier cpu/memory/disk triple through the flag path unchanged, matching --data", async () => {
    // Ross/HackerAI finding #4: `sandbox create --cpu 4 --memory 4gb --disk
    // 20gb` was rejected with "does not match a sandbox shape" while
    // `--data '{"cpu_count":4,"memory_mb":4096,"disk_size_mb":20480}'` and the
    // SDK's cpuCount/memoryMb/diskSizeMb succeeded. The flag path must send
    // the identical wire shape: no `size` field synthesized for an off-tier
    // triple.
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          template_id: "miosa-sandbox-docker",
          cpu_count: 4,
          memory_mb: 4096,
          disk_size_mb: 20480,
          timeout_sec: 3600,
          idle_timeout_sec: 0,
          persistent: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "sbx_ross", state: "running" } }),
        { headers: { "content-type": "application/json" } },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--template",
      "miosa-sandbox-docker",
      "--cpu",
      "4",
      "--memory",
      "4gb",
      "--disk",
      "20gb",
      "--json",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    expect(mock.pendingInterceptors()).toHaveLength(0);
  });

  it("rejects a legacy override that conflicts with the named size", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "create",
      "--size",
      "small",
      "--cpu",
      "4",
      "--memory",
      "8gb",
      "--disk",
      "20gb",
      "--json",
    ]);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(logged.join("\n")).toContain(
      "match medium, not requested size small",
    );
    expect(mock.pendingInterceptors()).toHaveLength(0);
  });

  it("renders lifecycle state instead of legacy status in list and show", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const pool = mock.get("https://api.miosa.ai");
    const sandbox = {
      id: "sbx_paused",
      name: "agent-workspace",
      state: "paused",
      status: "legacy-running",
      template_id: "miosa-sandbox",
      created_at: "2026-07-18T00:00:00Z",
    };

    pool
      .intercept({ path: "/api/v1/sandboxes", method: "GET" })
      .reply(200, JSON.stringify({ data: [sandbox] }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_paused", method: "GET" })
      .reply(200, JSON.stringify({ data: sandbox }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync(["node", "miosa", "sandbox", "list"]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "show",
      "sbx_paused",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("paused");
    expect(output).not.toContain("legacy-running");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("waits for sandbox VM readiness without requiring an app port", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "sbx_123",
            state: "running",
            ready: true,
            persistent: true,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    // After state=running, the wait confirms command-readiness against
    // GET /readiness before reporting success.
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/readiness",
        method: "GET",
      })
      .reply(200, JSON.stringify({ ready: true, state: "running" }), {
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
      "wait",
      "sbx_123",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("\n")) as Record<string, unknown>;
    expect(parsed["id"]).toBe("sbx_123");
    expect(parsed["sandbox_id"]).toBe("sbx_123");
    expect(parsed["ready"]).toBe(true);
    expect(parsed["url"]).toBeNull();
  });

  it("stops a sandbox through the persistent lifecycle endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/stop",
        method: "POST",
        body: JSON.stringify({}),
      })
      .reply(
        200,
        JSON.stringify({ data: { id: "sbx_123", state: "paused", persistent: true } }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "stop",
      "sbx_123",
      "--json",
    ]);

    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "sbx_123", state: "paused", persistent: true }, null, 2),
    );
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

describe("miosa sandbox connectors", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches a brokered provider connector to a sandbox", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/connectors",
        method: "POST",
        body: JSON.stringify({
          connector: "anthropic/workspace-claude",
          env_name: "ANTHROPIC_API_KEY",
          mode: "brokered-env",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "binding_123",
            connector: "anthropic/workspace-claude",
            env_name: "ANTHROPIC_API_KEY",
            mode: "brokered-env",
            placeholder_preview: "miosa-tok-...",
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
      "connectors",
      "attach",
      "sbx_123",
      "anthropic/workspace-claude",
      "--env",
      "ANTHROPIC_API_KEY",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["id"]).toBe("binding_123");
    expect(parsed["env_name"]).toBe("ANTHROPIC_API_KEY");
    expect(parsed["placeholder_preview"]).toBe("miosa-tok-...");
  });

  it("preflights a requested connector before sandbox run-agent exec", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/connectors/preflight",
        method: "POST",
        body: JSON.stringify({
          provider: "claude",
          connector: "anthropic/workspace-claude",
        }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/runs",
        method: "POST",
        body: JSON.stringify({
          target_kind: "sandbox",
          target_id: "sbx_123",
          runner: "claude",
          instruction: "hello",
          env: { FEATURE_FLAG: "on" },
          agent_runtime_profile_id: "prof_123",
          external_workspace_id: "clinic-iq",
          external_user_id: "founder-1",
          external_project_id: "landing-page",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            runner: "claude",
            status: "succeeded",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "run-agent",
      "sbx_123",
      "--connector",
      "anthropic/workspace-claude",
      "--env",
      "FEATURE_FLAG=on",
      "--agent-profile",
      "prof_123",
      "--external-workspace",
      "clinic-iq",
      "--external-user",
      "founder-1",
      "--external-project",
      "landing-page",
      "hello",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("supports custom in-sandbox agent runtimes", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/connectors/preflight",
        method: "POST",
        body: JSON.stringify({
          provider: "custom",
          connector: "ai/hermes",
          cwd: "/workspace",
        }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/runs",
        method: "POST",
        body: JSON.stringify({
          target_kind: "sandbox",
          target_id: "sbx_123",
          runner: "custom",
          instruction: "build the page",
          command: "hermes-agent run",
          cwd: "/workspace",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            runner: "custom",
            status: "succeeded",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "run-agent",
      "sbx_123",
      "--runner",
      "custom",
      "--runtime-command",
      "hermes-agent run",
      "--connector",
      "ai/hermes",
      "--cwd",
      "/workspace",
      "build",
      "the",
      "page",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});
