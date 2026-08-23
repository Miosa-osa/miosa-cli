import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Deployment, DeploymentBuild } from "../../src/types.js";

// ── shared mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
  ora: vi.fn(),
}));

// Mock inquirer so interactive prompts don't block
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

// Mock child_process for git operations
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const { register } = await import("../../src/commands/deploy.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

// ── test data ─────────────────────────────────────────────────────────────────

const mockDeployment: Deployment = {
  id: "dep-0000-0000-0000-000000000001" as import("../../src/types.js").DeploymentId,
  tenant_id:
    "ten-0000-0000-0000-000000000001" as import("../../src/types.js").TenantId,
  owner_id: "usr-0000-0000-0000-000000000001",
  name: "my-project",
  slug: "my-project-x7k2",
  repo_url: "https://github.com/acme/my-project",
  repo_provider: "github",
  branch: "main",
  build_command: "npm run build",
  run_command: "npm start",
  runtime_image: null,
  current_build_id: null,
  state: "running",
  auto_deploy: true,
  custom_domain_id: null,
  metadata: {},
  created_at: "2026-04-25T00:00:00Z",
  updated_at: "2026-04-25T00:00:00Z",
};

const mockBuild: DeploymentBuild = {
  id: "bld-0000-0000-0000-000000000001" as import("../../src/types.js").BuildId,
  deployment_id: mockDeployment.id,
  commit_sha: "abc123",
  commit_message: "feat: initial commit",
  triggered_by: "manual",
  state: "queued",
  started_at: null,
  finished_at: null,
  duration_ms: null,
  log_url: null,
  image_digest: null,
  error_message: null,
  created_at: "2026-04-25T00:00:00Z",
};

const mockTenant = {
  id: "ten-0000-0000-0000-000000000001",
  name: "Acme Corp",
  slug: "acme",
  plan: "pro",
  credit_balance: 1000,
  inserted_at: "2026-01-01T00:00:00Z",
};

function buildSseBody(events: string[]): string {
  return events.join("\n\n") + "\n\n";
}

// ── deploy list ───────────────────────────────────────────────────────────────

describe("miosa deploy list", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    delete process.env["MIOSA_JSON"];
    vi.restoreAllMocks();
  });

  it("should list deployments in table format", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/deployments", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockDeployment] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy", "list"]);

    const output = logged.join("\n");
    expect(output).toContain("my-project");
    expect(output).toContain("my-project-x7k2");
  });

  it("should output raw JSON with --json flag", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/deployments", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockDeployment] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy", "list", "--json"]);

    const raw = logged.join("");
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed[0] as Deployment).slug).toBe("my-project-x7k2");
    expect(raw).not.toMatch(/deployment\\(s\\)|MIOSA|────/);
  });

  it("should output raw JSON when global JSON mode is set", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/deployments", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockDeployment] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy", "list"]);

    const raw = logged.join("");
    const parsed = JSON.parse(raw) as unknown[];
    expect((parsed[0] as Deployment).slug).toBe(mockDeployment.slug);
    expect(raw).not.toMatch(/deployment\\(s\\)|MIOSA|────/);
  });

  it("passes state, workspace, and limit filters to the API", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments?state=running&workspace_id=ws_123&limit=20",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [mockDeployment] }), {
        headers: { "content-type": "application/json" },
      });

    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "list",
      "--state",
      "running",
      "--workspace",
      "ws_123",
      "--limit",
      "20",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should error on auth failure (401)", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/deployments", method: "GET" })
      .reply(401, JSON.stringify({ error: { message: "Unauthorized" } }), {
        headers: { "content-type": "application/json" },
      });

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy", "list"]);

    expect(errored.join(" ")).toMatch(/authorized|denied|auth/i);
    expect(process.exit).toHaveBeenCalledWith(3);
  });
});

describe("miosa deploy metrics", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches deployment metrics as raw JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep-0000-0000-0000-000000000001/metrics?window=7d",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          resource_type: "deployment",
          deployment_id: "dep-0000-0000-0000-000000000001",
          window: "7d",
          current: {
            state: "running",
            runtime_instances: { total: 1, active: 1, healthy: 1 },
            usage: { runtime_sec: 60, cost_cents: 1 },
          },
          series: { runtime_instance_count: [] },
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
      "deploy",
      "metrics",
      "dep-0000-0000-0000-000000000001",
      "--window",
      "7d",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["resource_type"]).toBe("deployment");
    expect(parsed["current"]).toEqual(
      expect.objectContaining({ state: "running" }),
    );
  });
});

// ── deploy redeploy ───────────────────────────────────────────────────────────

describe("miosa deploy redeploy", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  it("should queue a build with --no-follow and not stream logs", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/redeploy`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockBuild }), {
        headers: { "content-type": "application/json" },
      });

    const logSpied: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logSpied.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "redeploy",
      mockDeployment.id,
      "--no-follow",
    ]);

    // Should not have streamed a "Build log:" section
    expect(logSpied.join("\n")).not.toContain("Build log:");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});

// ── deploy env set ────────────────────────────────────────────────────────────

describe("miosa deploy env set", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  it("should set env vars and display masked preview", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/env`,
        method: "POST",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              name: "NODE_ENV",
              preview: "pro...ion",
              created_at: "2026-04-25T00:00:00Z",
              updated_at: "2026-04-25T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "env",
      "set",
      "NODE_ENV=production",
      "--id",
      mockDeployment.id,
    ]);

    expect(logged.join("\n")).toContain("NODE_ENV");
    expect(logged.join("\n")).toContain("pro...ion");
  });
});

// ── deploy env list ───────────────────────────────────────────────────────────

describe("miosa deploy env list", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  it("should display masked env var table", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/env`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              name: "DATABASE_URL",
              preview: "pos...url",
              created_at: "2026-04-25T00:00:00Z",
              updated_at: "2026-04-25T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "env",
      "list",
      mockDeployment.id,
    ]);

    expect(logged.join("\n")).toContain("DATABASE_URL");
    expect(logged.join("\n")).toContain("pos...url");
  });

  it("should show 'no env vars' message when list is empty", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/env`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "env",
      "list",
      mockDeployment.id,
    ]);

    expect(logged.join("\n")).toContain("No env vars");
  });
});

// ── deploy logs ───────────────────────────────────────────────────────────────

describe("miosa deploy logs", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("should stream log_line SSE events to stdout", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const sseBody = buildSseBody([
      'event: log_line\ndata: {"stream":"stdout","line":"npm run build","ts":"2026-04-25T10:01:00Z"}',
      'event: log_line\ndata: {"stream":"stdout","line":"Build successful","ts":"2026-04-25T10:01:05Z"}',
      'data: {"type":"done"}',
    ]);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/logs`,
        method: "GET",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "logs",
      mockDeployment.id,
    ]);

    // stdout.write called with log lines
    expect(process.stdout.write).toHaveBeenCalled();
  });
});

// ── deploy (main action) — error scenarios ────────────────────────────────────

describe("miosa deploy (main action) — error scenarios", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("should error with helpful message when not a git repo", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });

    // Change cwd to tmpDir (no .miosa.json there)
    const origCwd = process.cwd;
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy"]);

    expect(errored.join(" ")).toContain("git");
    expect(process.exit).toHaveBeenCalledWith(1);

    process.cwd = origCwd;
  });

  it("should error with helpful message when no remote origin", async () => {
    const { execSync } = await import("node:child_process");
    // First call (git rev-parse --git-dir) succeeds, second (get-url) fails
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from(".git"))
      .mockImplementationOnce(() => {
        throw new Error("No such remote 'origin'");
      });

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy"]);

    expect(errored.join(" ")).toContain("remote");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ── deploy (main action) — Docker Deploy ─────────────────────────────────────

describe("miosa deploy --docker-deploy", () => {
  let tmpDir: string;
  let originalStdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    originalStdinIsTTY = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env["MIOSA_JSON"];
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    vi.restoreAllMocks();
  });

  async function arrangeFirstDockerDeploy(expected: {
    name: string;
    branch: string;
    buildCommand?: string;
    runCommand?: string;
  }): Promise<{ logged: string[]; program: Command }> {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockReset();
    vi.mocked(execSync).mockImplementation((cmd) => {
      const command = String(cmd);
      if (command.includes("rev-parse --git-dir")) return Buffer.from(".git");
      if (command.includes("remote get-url origin")) {
        return "https://github.com/acme/app.git\n";
      }
      if (command.includes("rev-parse --abbrev-ref HEAD")) {
        return "main\n";
      }
      return Buffer.from("");
    });

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "15.0.0" },
      }),
    );

    const dockerDeployment: Deployment = {
      ...mockDeployment,
      name: expected.name,
      slug: expected.name,
      deployment_product: "docker_deploy",
      docker_deploy_host_id: "ddh_123",
    };

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: "/api/v1/deployments",
        method: "POST",
        body: JSON.stringify({
          name: expected.name,
          repo_url: "https://github.com/acme/app",
          branch: expected.branch,
          ...(expected.buildCommand
            ? { build_command: expected.buildCommand }
            : {}),
          ...(expected.runCommand ? { run_command: expected.runCommand } : {}),
          auto_deploy: true,
          metadata: { deployment_product: "docker_deploy" },
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: dockerDeployment,
          webhook_secret: "whsec_test",
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/redeploy`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockBuild }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/logs`,
        method: "GET",
      })
      .reply(200, buildSseBody(['data: {"type":"done"}']), {
        headers: { "content-type": "text/event-stream" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: dockerDeployment }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/platform/tenants/current",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockTenant }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    return { logged, program: buildProgram() };
  }

  it("creates a first deployment without prompting when stdin is non-interactive", async () => {
    const { logged, program } = await arrangeFirstDockerDeploy({
      name: path.basename(tmpDir),
      branch: "main",
      buildCommand: "npm run build",
      runCommand: "npm start",
    });

    await program.parseAsync(["node", "miosa", "deploy", "--docker-deploy"]);

    const inquirer = await import("inquirer");
    const output = logged.join("\n");
    expect(output).toContain("App Engine");
    expect(output).toContain("ddh_123");
    expect(inquirer.default.prompt).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("uses explicit deployment inputs in non-interactive automation", async () => {
    const { program } = await arrangeFirstDockerDeploy({
      name: "automated-app",
      branch: "release",
      buildCommand: "pnpm build",
      runCommand: "node server.js",
    });

    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "--docker-deploy",
      "--name",
      "automated-app",
      "--branch",
      "release",
      "--build-command",
      "pnpm build",
      "--run-command",
      "node server.js",
      "--yes",
    ]);

    const inquirer = await import("inquirer");
    expect(inquirer.default.prompt).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("deploys static HTML without build or run command prompts", async () => {
    const { program } = await arrangeFirstDockerDeploy({
      name: "callix-security-report",
      branch: "master",
    });

    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "--docker-deploy",
      "--static",
      "--name",
      "callix-security-report",
      "--branch",
      "master",
      "--yes",
    ]);

    const inquirer = await import("inquirer");
    expect(inquirer.default.prompt).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("rejects ambiguous static and command-driven deployment inputs", async () => {
    const { program } = await arrangeFirstDockerDeploy({
      name: "unused",
      branch: "main",
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "--docker-deploy",
      "--static",
      "--build-command",
      "npm run build",
      "--yes",
    ]);

    expect(errors.join("\n")).toContain(
      "--static cannot be combined with build or run commands.",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("preserves guided prompts for an interactive first deployment", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const { program } = await arrangeFirstDockerDeploy({
      name: "guided-app",
      branch: "main",
      buildCommand: "npm run build",
      runCommand: "npm start",
    });
    const inquirer = await import("inquirer");
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
      name: "guided-app",
      branch: "main",
      buildCommand: "npm run build",
      runCommand: "npm start",
      confirm: true,
    });

    await program.parseAsync(["node", "miosa", "deploy", "--docker-deploy"]);

    expect(inquirer.default.prompt).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("prints one stable result document in JSON mode without prompting on a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    process.env["MIOSA_JSON"] = "1";
    const { logged, program } = await arrangeFirstDockerDeploy({
      name: path.basename(tmpDir),
      branch: "main",
      buildCommand: "npm run build",
      runCommand: "npm start",
    });

    await program.parseAsync(["node", "miosa", "deploy", "--docker-deploy"]);

    const result = JSON.parse(logged.join("\n")) as {
      ok: boolean;
      deployment: { id: string; deployment_product: string };
      build: { id: string; state: string };
      webhook: { secret: string } | null;
    };
    const inquirer = await import("inquirer");
    expect(result).toMatchObject({
      ok: true,
      deployment: {
        id: mockDeployment.id,
        deployment_product: "docker_deploy",
      },
      build: { id: mockBuild.id, state: "queued" },
      webhook: { secret: "whsec_test" },
    });
    expect(inquirer.default.prompt).not.toHaveBeenCalled();
  });
});

describe("miosa deploy prove", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    delete process.env["MIOSA_JSON"];
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("proves a Docker Deploy deployment from the app truth row", async () => {
    const deployment = {
      ...mockDeployment,
      deployment_product: "docker_deploy",
      docker_deploy_host_id: "ddh_123",
      public_url: "https://docker-site.example.com",
      docker_deploy_app: {
        id: "app_row_123",
        docker_deploy_host_id: "ddh_123",
        app_id: "dokploy_app_123",
        container_id: "container_123",
        status: "running",
        runtime_ip: "172.16.74.246",
        runtime_port: 23906,
        public_url: "https://docker-site.example.com",
        last_health_status: "healthy",
      },
      metadata: {
        deployment_product: "docker_deploy",
        runtime: {
          ip: "172.16.74.200",
          port: 20000,
        },
      },
    };

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ddh_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          host: {
            id: "ddh_123",
            status: "active",
            appliance_status: "healthy",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "prove",
      mockDeployment.id,
      "--no-probe",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "docker_deploy_app_row", ok: true }),
    );
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "docker_deploy_container_route", ok: true }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("fails proof when Docker Deploy is metadata-only", async () => {
    const deployment = {
      ...mockDeployment,
      deployment_product: "docker_deploy",
      docker_deploy_host_id: "ddh_123",
      public_url: "https://docker-site.example.com",
      docker_deploy_app: null,
      metadata: {
        deployment_product: "docker_deploy",
        runtime: {
          ip: "172.16.74.246",
          port: 23906,
        },
      },
    };

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/docker-deploy/hosts/ddh_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          host: {
            id: "ddh_123",
            status: "active",
            appliance_status: "healthy",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "prove",
      mockDeployment.id,
      "--no-probe",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      checks: Array<{ id: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "docker_deploy_app_row", ok: false }),
    );
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ id: "docker_deploy_container_route", ok: false }),
    );
    expect(process.exitCode).toBe(1);
  });
});

// ── deploy (main action) — existing .miosa.json ───────────────────────────────

describe("miosa deploy (main action) — existing .miosa.json reuse", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("should skip detection and prompts when .miosa.json exists and trigger redeploy + stream", async () => {
    // Write a .miosa.json
    const projectCfg = {
      version: 1,
      deploymentId: mockDeployment.id,
      name: "my-project",
      framework: "nextjs",
      buildCommand: "npm run build",
      runCommand: "npm start",
      branch: "main",
    };
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify(projectCfg),
    );

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    // redeploy
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/redeploy`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockBuild }), {
        headers: { "content-type": "application/json" },
      });

    // logs SSE
    const sseBody = buildSseBody([
      'event: log_line\ndata: {"stream":"stdout","line":"Build complete","ts":"2026-04-25T10:01:00Z"}',
      'data: {"type":"done"}',
    ]);
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/logs`,
        method: "GET",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    // GET deployment (for final URL)
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockDeployment }), {
        headers: { "content-type": "application/json" },
      });

    // GET tenant (for URL construction)
    pool
      .intercept({
        path: "/api/v1/platform/tenants/current",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockTenant }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy"]);

    const output = logged.join("\n");
    expect(output).toContain("my-project");
    // Should show the deployment URL
    expect(output).toContain("miosa.app");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should print failure message and exit 1 on failed build", async () => {
    const projectCfg = {
      version: 1,
      deploymentId: mockDeployment.id,
      name: "my-project",
      framework: "nextjs",
      buildCommand: "npm run build",
      runCommand: "npm start",
      branch: "main",
    };
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify(projectCfg),
    );

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/redeploy`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockBuild }), {
        headers: { "content-type": "application/json" },
      });

    // SSE stream with error event
    const sseBody = buildSseBody([
      'data: {"type":"error","message":"Build script exited with code 2"}',
    ]);
    pool
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}/logs`,
        method: "GET",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy"]);

    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
