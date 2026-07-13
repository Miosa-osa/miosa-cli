import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
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

describe("miosa sandbox dev up", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates, safely syncs, installs, starts, and proves declared services", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-dev-up-"));
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    fs.writeFileSync(path.join(dir, "package.json"), "{\"name\":\"clinic\"}\n");
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic
sandbox:
  name: clinic-dev
  template: node
  workdir: /workspace
dependencies:
  install: npm ci
services:
  web:
    command: npm run dev
    port: 3000
    health:
      path: /health
      timeout: 30
`,
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const api = mock.get("https://api.miosa.ai");
    api
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({ name: "clinic-dev", template_id: "node", persistent: true }),
      })
      .reply(201, JSON.stringify({ data: { id: "sbx_dev", state: "creating" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "sbx_dev", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/files", method: "POST" })
      .reply(201, JSON.stringify({ data: { path: "/tmp/miosa-dev-sync.tgz" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0 } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0 } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/services/web", method: "GET" })
      .reply(404, JSON.stringify({ error: { message: "not found" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({
        path: "/api/v1/sandboxes/sbx_dev/services",
        method: "POST",
        body: JSON.stringify({ name: "web", command: "npm run dev", cwd: "/workspace" }),
      })
      .reply(201, JSON.stringify({ data: { name: "web", status: "running" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "200\n" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({
        path: "/api/v1/sandboxes/sbx_dev/expose",
        method: "POST",
        body: JSON.stringify({ port: 3000, title: "clinic web" }),
      })
      .reply(
        200,
        JSON.stringify({ data: { url: "https://api.miosa.ai/previews/sbx_dev/3000" } }),
        { headers: { "content-type": "application/json" } },
      );
    api
      .intercept({ path: "/previews/sbx_dev/3000/health", method: "GET" })
      .reply(200, "ok");

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "dev",
      "up",
      "--dir",
      dir,
      "--json",
    ]);

    const result = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      sandbox_id: "sbx_dev",
      reused: false,
      services: {
        web: {
          healthy: true,
          preview_url: "https://api.miosa.ai/previews/sbx_dev/3000",
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".miosa", "sandbox.json"), "utf8"))).toMatchObject({
      sandbox_id: "sbx_dev",
      project: "clinic",
    });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("reuses resumability state and restarts an existing service", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-dev-resume-"));
    fs.mkdirSync(path.join(dir, ".miosa"));
    fs.writeFileSync(
      path.join(dir, ".miosa", "sandbox.json"),
      JSON.stringify({ schema_version: 1, project: "clinic", sandbox_id: "sbx_existing" }),
    );
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic
dependencies:
  install: false
services:
  web:
    command: npm run dev
    port: 3000
    health:
      path: /health
`,
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const api = mock.get("https://api.miosa.ai");
    for (let index = 0; index < 2; index += 1) {
      api
        .intercept({ path: "/api/v1/sandboxes/sbx_existing", method: "GET" })
        .reply(200, JSON.stringify({ data: { id: "sbx_existing", state: "running" } }), {
          headers: { "content-type": "application/json" },
        });
    }
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/files", method: "POST" })
      .reply(200, JSON.stringify({ data: {} }), { headers: { "content-type": "application/json" } });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0 } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/services/web", method: "GET" })
      .reply(200, JSON.stringify({ data: { status: "running" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/services/web/restart", method: "POST", body: "{}" })
      .reply(200, JSON.stringify({ data: { status: "running" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "200\n" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_existing/expose", method: "POST" })
      .reply(200, JSON.stringify({ data: { url: "https://api.miosa.ai/previews/sbx_existing/3000" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/previews/sbx_existing/3000/health", method: "GET" })
      .reply(200, "ok");

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "dev",
      "up",
      "--dir",
      dir,
      "--json",
    ]);

    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      sandbox_id: "sbx_existing",
      reused: true,
    });
  });

  it("does not create a replacement for a missing explicitly selected sandbox", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-dev-explicit-"));
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic
dependencies:
  install: false
services:
  web:
    command: npm run dev
    port: 3000
    health:
      path: /health
`,
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/sandboxes/missing", method: "GET" })
      .reply(404, JSON.stringify({ error: { message: "not found" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "dev",
      "up",
      "--dir",
      dir,
      "--sandbox",
      "missing",
    ]);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Explicitly selected sandbox missing was not found"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe("miosa sandbox doctor --full", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inspects the complete developer contract without revealing values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-doctor-full-"));
    fs.mkdirSync(path.join(dir, ".miosa"));
    fs.writeFileSync(
      path.join(dir, ".miosa", "sandbox.json"),
      JSON.stringify({ schema_version: 1, project: "clinic", sandbox_id: "sbx_dev" }),
    );
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic
sandbox:
  workdir: /workspace
dependencies:
  install: npm ci
services:
  web:
    command: npm run dev
    port: 3000
    health:
      path: /health
requirements:
  config: [NODE_ENV]
  secrets: [SESSION_SECRET]
  database: true
`,
    );

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const api = mock.get("https://api.miosa.ai");
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "sbx_dev", state: "running", database_id: "db_123" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "MIOSA_EXEC_OK\n" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "/workspace\n" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/services/web", method: "GET" })
      .reply(200, JSON.stringify({ data: { name: "web", status: "running" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/exec", method: "POST" })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "200\n" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/expose", method: "POST" })
      .reply(200, JSON.stringify({ data: { url: "https://api.miosa.ai/previews/sbx_dev/3000" } }), {
        headers: { "content-type": "application/json" },
      });
    api
      .intercept({ path: "/previews/sbx_dev/3000/health", method: "GET" })
      .reply(200, "ok");
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/env", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            { name: "NODE_ENV", value: "development" },
            { name: "SESSION_SECRET", value: "must-not-appear" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    api
      .intercept({ path: "/api/v1/sandboxes/sbx_dev/snapshots", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "doctor",
      "--full",
      "--dir",
      dir,
      "--json",
    ]);

    const raw = output.join("\n");
    const result = JSON.parse(raw) as {
      ok: boolean;
      failure_codes: string[];
      checks: Array<{ id: string; ok: boolean; code: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.failure_codes).toEqual([]);
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "api_state",
        "exec_channel",
        "filesystem",
        "service:web",
        "listener:web",
        "preview:web",
        "database",
        "config:NODE_ENV",
        "secret:SESSION_SECRET",
        "snapshot",
      ]),
    );
    expect(raw).not.toContain("must-not-appear");
  });
});
