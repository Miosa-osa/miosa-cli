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
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({ text: "", stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() }),
  ora: vi.fn(),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

const { register } = await import("../../src/commands/pull.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const DEPLOYMENT_ID = "dep-pull-test-0000-000000000000";

const mockEnvVars = [
  {
    name: "DATABASE_URL",
    preview: "postgres://***",
    created_at: "",
    updated_at: "",
  },
  { name: "SECRET_KEY", preview: "sk_***", created_at: "", updated_at: "" },
];

describe("miosa pull", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-pull-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("should write .env.local with secret keys when linked", async () => {
    // Write a .miosa.json link file
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify({
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        name: "my-app",
        environment: "production",
      }),
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    // Deployment env vars
    pool
      .intercept({
        path: `/api/v1/deployments/${DEPLOYMENT_ID}/env`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockEnvVars }), {
        headers: { "content-type": "application/json" },
      });

    // Tenant secrets (no matches — will fall back to preview values)
    pool
      .intercept({
        path: "/api/v1/opencomputers/secrets",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "pull", "--overwrite"]);

    const envLocal = path.join(tmpDir, ".env.local");
    expect(fs.existsSync(envLocal)).toBe(true);

    const contents = fs.readFileSync(envLocal, "utf8");
    expect(contents).toContain("DATABASE_URL=");
    expect(contents).toContain("SECRET_KEY=");
  });

  it("should print JSON when --json flag is passed", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify({
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        name: "my-app",
        environment: "production",
      }),
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: `/api/v1/deployments/${DEPLOYMENT_ID}/env`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockEnvVars }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/opencomputers/secrets",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "pull", "--json"]);

    const output = logged.join("\n");
    const parsed = JSON.parse(output) as Record<string, string>;
    expect(Object.keys(parsed)).toContain("DATABASE_URL");
    expect(Object.keys(parsed)).toContain("SECRET_KEY");

    // No file written
    expect(fs.existsSync(path.join(tmpDir, ".env.local"))).toBe(false);
  });

  it("should error when no .miosa.json and no --app flag", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "pull"]);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should use --app flag to override link file", async () => {
    const altId = "dep-alt-0000-000000000000";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: `/api/v1/deployments/${altId}/env`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [mockEnvVars[0]] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/opencomputers/secrets",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "pull",
      "--app",
      altId,
      "--overwrite",
    ]);

    const envLocal = path.join(tmpDir, ".env.local");
    expect(fs.existsSync(envLocal)).toBe(true);
    expect(fs.readFileSync(envLocal, "utf8")).toContain("DATABASE_URL=");
  });

  it("should add .env.local to .gitignore", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify({
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        name: "my-app",
        environment: "production",
      }),
    );
    // Pre-existing .gitignore without .env.local
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules\n");

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: `/api/v1/deployments/${DEPLOYMENT_ID}/env`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [mockEnvVars[0]] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/opencomputers/secrets",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "pull", "--overwrite"]);

    const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env.local");
  });
});
