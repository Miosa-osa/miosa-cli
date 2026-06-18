import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
}));

const { register } = await import("../../src/commands/devices.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function captureLogs(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  return logged;
}

describe("miosa devices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("lists unified hosted devices through the devices API", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices?kind=sandbox",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ id: "sbx_123", kind: "sandbox", name: "build", ready: true }],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "list",
      "--type",
      "sandbox",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      devices: [{ id: "sbx_123", kind: "sandbox_worker", ready: true }],
    });
  });

  it("executes a command in a device", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/exec",
        method: "POST",
        body: JSON.stringify({
          command: "printf ok",
          timeout_ms: 30000,
          cwd: "/workspace",
          env: { NODE_ENV: "test" },
        }),
      })
      .reply(
        200,
        JSON.stringify({ data: { exit_code: 0, stdout: "ok" } }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "exec",
      "sbx_123",
      "--command",
      "printf ok",
      "--timeout-ms",
      "30000",
      "--cwd",
      "/workspace",
      "--env",
      "NODE_ENV=test",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      exit_code: 0,
      stdout: "ok",
    });
  });

  it("reads, writes, and exposes device artifacts", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/files/read?path=%2Fworkspace%2Fout.html",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            path: "/workspace/out.html",
            encoding: "base64",
            content: "PGgxPk9LPC9oMT4=",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/files/write",
        method: "POST",
        body: JSON.stringify({
          path: "/workspace/out.html",
          content_base64: "PGgxPk9LPC9oMT4=",
        }),
      })
      .reply(200, JSON.stringify({ data: { path: "/workspace/out.html", size: 11 } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/expose",
        method: "POST",
        body: JSON.stringify({ port: 3000 }),
      })
      .reply(
        200,
        JSON.stringify({ data: { port: 3000, url: "https://3000-sbx.sandbox.miosa.app" } }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "files",
      "read",
      "sbx_123",
      "--path",
      "/workspace/out.html",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "files",
      "write",
      "sbx_123",
      "--path",
      "/workspace/out.html",
      "--content-base64",
      "PGgxPk9LPC9oMT4=",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "expose",
      "sbx_123",
      "--port",
      "3000",
      "--json",
    ]);

    const outputs = logged.map((line) => JSON.parse(line));
    expect(outputs[0]).toMatchObject({ encoding: "base64" });
    expect(outputs[1]).toMatchObject({ size: 11 });
    expect(outputs[2]).toMatchObject({ port: 3000 });
  });

  it("runs a standard device doctor probe", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/capabilities",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { capabilities: { exec: true } } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/exec",
        method: "POST",
        body: JSON.stringify({ command: "pwd && uname -s", timeout_ms: 30000 }),
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "/workspace\nLinux\n" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/files?path=%2Fworkspace",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "doctor",
      "sbx_123",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      device_id: "sbx_123",
      ok: true,
      checks: [
        { name: "capabilities", ok: true },
        { name: "exec", ok: true },
        { name: "files", ok: true },
      ],
    });
  });

  it("manages device lifecycle", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/extend",
        method: "POST",
        body: JSON.stringify({ timeout_sec: 7200 }),
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_123", timeout_sec: 7200 } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123",
        method: "DELETE",
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_123", state: "destroyed" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "extend",
      "sbx_123",
      "--timeout-sec",
      "7200",
      "--json",
    ]);
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "destroy",
      "sbx_123",
      "--json",
    ]);

    const outputs = logged.map((line) => JSON.parse(line));
    expect(outputs[0]).toMatchObject({ id: "sbx_123", timeout_sec: 7200 });
    expect(outputs[1]).toMatchObject({ id: "sbx_123", state: "destroyed" });
  });

  it("bootstraps an agent runtime manifest on a device", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/files/write",
        method: "POST",
      })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body)) as {
          path: string;
          content: string;
        };
        const manifest = JSON.parse(body.content) as Record<string, unknown>;
        expect(body.path).toBe("/workspace/.miosa/runtime-bootstrap.json");
        expect(manifest).toMatchObject({
          version: 1,
          runtime: "claude-code",
          cwd: "/workspace",
          connectors: ["anthropic/workspace-claude"],
          env: { ANTHROPIC_API_KEY: "miosa-tok-placeholder" },
          mcp: [{ name: "refero", url: "https://api.refero.design/mcp" }],
        });
        return JSON.stringify({ data: { path: body.path, size: body.content.length } });
      }, { headers: { "content-type": "application/json" } });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/sbx_123/exec",
        method: "POST",
      })
      .reply(200, (opts) => {
        const body = JSON.parse(String(opts.body)) as { command: string; cwd: string };
        expect(body.cwd).toBe("/workspace");
        expect(body.command).toContain("runtime available");
        return JSON.stringify({ data: { exit_code: 0, stdout: "runtime available\n" } });
      }, { headers: { "content-type": "application/json" } });

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "bootstrap",
      "sbx_123",
      "--runtime",
      "claude-code",
      "--connector",
      "anthropic/workspace-claude",
      "--env",
      "ANTHROPIC_API_KEY=miosa-tok-placeholder",
      "--mcp",
      "refero=https://api.refero.design/mcp",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      device_id: "sbx_123",
      ok: true,
      runtime: "claude-code",
      manifest_path: "/workspace/.miosa/runtime-bootstrap.json",
      steps: [{ name: "write_manifest", ok: true }, { name: "probe", ok: true }],
    });
  });

  it("returns browser connection details", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/devices/comp_123/browser",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            kind: "computer_browser",
            desktop_url: "https://desktop.example.test",
            ws_url: "wss://desktop.example.test/vnc/websockify",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "devices",
      "browser",
      "comp_123",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      kind: "computer_browser",
      desktop_url: "https://desktop.example.test",
    });
  });
});
