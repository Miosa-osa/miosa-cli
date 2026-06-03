import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import type { Host } from "../../src/types.js";

const runWsPtyMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    warn: vi.fn(),
    fail: vi.fn(),
  }),
}));

vi.mock("../../src/pty/ws-pty-client.js", () => ({
  runWsPty: runWsPtyMock,
}));

const { register } = await import("../../src/commands/ssh.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const computer = {
  id: "comp-0000-0000-0000-000000000001",
  name: "my-computer",
  status: "running",
};

const host: Host = {
  id: "host-0000-0000-0000-000000000001" as import("../../src/types.js").HostId,
  name: "my-host",
  state: "online",
  os: "linux",
  platform: "linux",
  arch: "x86_64",
  hostname: "my-host.local",
  last_heartbeat: "2026-01-01T00:00:00Z",
  host_key: null,
  install_command: null,
  tenant_id: "tenant-0000-0000-0000-000000000001" as import("../../src/types.js").TenantId,
  inserted_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("miosa ssh", () => {
  beforeEach(() => {
    runWsPtyMock.mockClear();
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a terminal on a MIOSA Computer before trying OpenComputers hosts", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(200, JSON.stringify({ data: [computer] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/terminal`,
        method: "POST",
        body: JSON.stringify({
          cmd: "/bin/bash",
          env: { TERM: "xterm-256color" },
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "pty-0000-0000-0000-000000000001",
            ws_url: "wss://api.miosa.ai/api/v1/computers/pty/ws?ticket=abc",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "ssh",
      "my-computer",
      "--cmd",
      "whoami",
    ]);

    expect(runWsPtyMock).toHaveBeenCalledWith({
      url: "wss://api.miosa.ai/api/v1/computers/pty/ws?ticket=abc",
      token: "msk_u_test",
      oneShot: "whoami",
    });
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("falls back to OpenComputers hosts when no Computer matches", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/opencomputers/hosts/my-host",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: host }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/opencomputers/hosts/${host.id}/terminal/ticket`,
        method: "POST",
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            url: "wss://api.miosa.ai/api/v1/opencomputers/hosts/ws",
            token: "terminal_ticket",
            expires_at: "2026-01-01T01:00:00Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "ssh", "my-host"]);

    expect(runWsPtyMock).toHaveBeenCalledWith({
      url: "wss://api.miosa.ai/api/v1/opencomputers/hosts/ws",
      token: "terminal_ticket",
      oneShot: undefined,
    });
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
