import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

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

const { register } = await import("../../src/commands/dev.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const DEPLOYMENT_ID = "dep-dev-test-0000-000000000000";

function makeFakeChild(exitCode: number): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  setImmediate(() => emitter.emit("close", exitCode));
  return emitter;
}

describe("miosa dev", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-dev-test-"));
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

  it("should detect Next.js and spawn next dev", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0", react: "^18.0.0" } }),
    );
    fs.writeFileSync(path.join(tmpDir, "next.config.ts"), "export default {};");
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify({
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        name: "my-next-app",
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
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({ path: "/api/v1/opencomputers/secrets", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "dev"]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "next",
      expect.arrayContaining(["dev"]),
      expect.objectContaining({
        env: expect.objectContaining({ PORT: "4000" }),
        stdio: "inherit",
        shell: true,
      }),
    );
  });

  it("should honour --port flag", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, ".miosa.json"),
      JSON.stringify({
        version: 1,
        deploymentId: DEPLOYMENT_ID,
        name: "my-next-app",
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
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({ path: "/api/v1/opencomputers/secrets", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "dev", "--port", "9000"]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ PORT: "9000" }),
      }),
    );
  });

  it("should honour --command flag and bypass framework detection", async () => {
    // Empty directory — would fail auto-detection without --command
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "dev",
      "--command",
      "node server.js",
    ]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ stdio: "inherit", shell: true }),
    );
  });

  it("should inject secrets from linked deployment", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
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
    await program.parseAsync(["node", "miosa", "dev"]);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          DATABASE_URL: expect.any(String),
        }),
      }),
    );
  });

  it("should error when no framework detected and no --command", async () => {
    // Empty directory — no framework marker files
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "dev"]);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
