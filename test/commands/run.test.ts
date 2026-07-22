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

// Mock child_process at module level so spawn is configurable
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

const { register } = await import("../../src/commands/run.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const DEPLOYMENT_ID = "dep-run-test-0000-000000000000";

function makeFakeChild(exitCode: number): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  setImmediate(() => emitter.emit("close", exitCode));
  return emitter;
}

describe("miosa run", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-run-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeChild(0));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.mocked(childProcess.spawn).mockReset();
  });

  it("should spawn the given command with env vars injected", async () => {
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
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              name: "DATABASE_URL",
              preview: "postgres://preview",
              created_at: "",
              updated_at: "",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: "/api/v1/opencomputers/secrets", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "run", "npm", "test"]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "npm",
      ["test"],
      expect.objectContaining({
        env: expect.objectContaining({
          DATABASE_URL: expect.any(String),
        }),
        stdio: "inherit",
      }),
    );
  });

  it("should exit with the child process exit code", async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => makeFakeChild(7));

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "run", "exit", "7"]);

    expect(process.exit).toHaveBeenCalledWith(7);
  });

  it("should run without secrets when no link file and no --app", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "run", "echo", "hello"]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "echo",
      ["hello"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("should use --app flag to override link file", async () => {
    const altId = "dep-alt-run-0000-000000000000";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({
        path: `/api/v1/deployments/${altId}/env`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              name: "API_KEY",
              preview: "sk-***",
              created_at: "",
              updated_at: "",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({ path: "/api/v1/opencomputers/secrets", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "run",
      "--app",
      altId,
      "node",
      "script.js",
    ]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "node",
      ["script.js"],
      expect.objectContaining({
        env: expect.objectContaining({ API_KEY: expect.any(String) }),
      }),
    );
  });

  it("should skip secret injection when --no-secrets flag is passed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "run",
      "--no-secrets",
      "node",
      "--version",
    ]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "node",
      ["--version"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
