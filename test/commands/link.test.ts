import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Deployment } from "../../src/types.js";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({ text: "", stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() }),
  ora: vi.fn(),
}));

// Suppress inquirer prompts in the --app path (not needed there)
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

const { register } = await import("../../src/commands/link.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const mockDeployment: Deployment = {
  id: "dep-aaaa-bbbb-cccc-dddddddddddd" as import("../../src/types.js").DeploymentId,
  tenant_id: "t_123" as import("../../src/types.js").TenantId,
  owner_id: "u_1",
  name: "my-app",
  slug: "my-app-abc",
  repo_url: "https://github.com/org/my-app",
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
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("miosa link", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-link-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("should write .miosa.json when --app flag is passed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockDeployment }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "link",
      "--app",
      mockDeployment.id,
    ]);

    const linkFile = path.join(tmpDir, ".miosa.json");
    expect(fs.existsSync(linkFile)).toBe(true);

    const written = JSON.parse(fs.readFileSync(linkFile, "utf8")) as {
      deploymentId: string;
      name: string;
      environment: string;
      version: number;
    };
    expect(written.deploymentId).toBe(mockDeployment.id);
    expect(written.name).toBe("my-app");
    expect(written.environment).toBe("production");
    expect(written.version).toBe(1);
  });

  it("should use --env flag value in written link", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/${mockDeployment.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockDeployment }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "link",
      "--app",
      mockDeployment.id,
      "--env",
      "staging",
    ]);

    const written = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".miosa.json"), "utf8"),
    ) as { environment: string };
    expect(written.environment).toBe("staging");
  });

  it("should error when API returns 404", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/deployments/bad-id`,
        method: "GET",
      })
      .reply(404, JSON.stringify({ message: "Not found" }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "link", "--app", "bad-id"]);

    expect(process.exit).toHaveBeenCalledWith(expect.any(Number));
    expect(fs.existsSync(path.join(tmpDir, ".miosa.json"))).toBe(false);
  });
});
