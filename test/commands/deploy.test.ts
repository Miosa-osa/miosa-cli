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

  it("creates a deployment with docker_deploy metadata", async () => {
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

    const inquirer = await import("inquirer");
    vi.mocked(inquirer.default.prompt).mockResolvedValueOnce({
      name: "docker-app",
      branch: "main",
      buildCommand: "npm run build",
      runCommand: "npm start",
      confirm: true,
    });

    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);

    const dockerDeployment: Deployment = {
      ...mockDeployment,
      name: "docker-app",
      slug: "docker-app",
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
          name: "docker-app",
          repo_url: "https://github.com/acme/app",
          branch: "main",
          build_command: "npm run build",
          run_command: "npm start",
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

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "deploy", "--docker-deploy"]);

    const output = logged.join("\n");
    expect(output).toContain("Docker Deploy");
    expect(output).toContain("ddh_123");
    expect(process.exit).not.toHaveBeenCalledWith(1);
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
