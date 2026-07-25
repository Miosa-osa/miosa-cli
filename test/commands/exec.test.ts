import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import type { Host } from "../../src/types.js";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  saveConfig: vi.fn(),
}));

// Mock spinner so tests don't produce ora output
vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
  ora: vi.fn(),
}));

const { register } = await import("../../src/commands/exec.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const mockHost: Host = {
  id: "host-abc-1234-0000-0000-000000000000" as import("../../src/types.js").HostId,
  name: "my-mac",
  state: "online",
  os: "macOS",
  platform: "darwin",
  arch: "arm64",
  hostname: "MacBook.local",
  last_heartbeat: new Date().toISOString(),
  host_key: null,
  install_command: null,
  tenant_id: "t_123" as import("../../src/types.js").TenantId,
  inserted_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

function buildSseBody(events: string[]): string {
  return events.join("\n\n") + "\n\n";
}

describe("miosa exec", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("runs a command on a MIOSA computer by its friendly name", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(
        200,
        JSON.stringify([
          {
            id: "61f5ee2d-eadf-40f6-9d75-43d560cad163",
            name: "boris",
            status: "running",
          },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/computers/61f5ee2d-eadf-40f6-9d75-43d560cad163/exec",
        method: "POST",
        body: JSON.stringify({ command: "pwd" }),
      })
      .reply(
        200,
        buildSseBody([
          'data: {"type":"stdout","data":"/home/ubuntu\\n"}',
          'data: {"type":"exit","exit_code":0}',
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "exec",
      "boris",
      "pwd",
    ]);

    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("/home/ubuntu"),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("should stream stdout events to process.stdout", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    // GET /hosts → resolve host
    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockHost] }), {
        headers: { "content-type": "application/json" },
      });

    // POST /hosts/:id/jobs → SSE stream
    const sseBody = buildSseBody([
      'data: {"type":"stdout","data":"hello world\\n"}',
      'data: {"type":"exit","exit_code":0}',
    ]);

    pool
      .intercept({
        path: `/api/v1/opencomputers/hosts/${mockHost.id}/jobs`,
        method: "POST",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "exec",
      "my-mac",
      "echo",
      "hello world",
    ]);

    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("hello world"),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("should stream stderr events to process.stderr", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockHost] }), {
        headers: { "content-type": "application/json" },
      });

    const sseBody = buildSseBody([
      'data: {"type":"stderr","data":"error: something went wrong\\n"}',
      'data: {"type":"exit","exit_code":1}',
    ]);

    pool
      .intercept({
        path: `/api/v1/opencomputers/hosts/${mockHost.id}/jobs`,
        method: "POST",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "exec",
      "my-mac",
      "bad-command",
    ]);

    expect(process.stderr.write).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should propagate remote exit code", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockHost] }), {
        headers: { "content-type": "application/json" },
      });

    const sseBody = buildSseBody(['data: {"type":"exit","exit_code":42}']);

    pool
      .intercept({
        path: `/api/v1/opencomputers/hosts/${mockHost.id}/jobs`,
        method: "POST",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "exec", "my-mac", "exit", "42"]);

    expect(process.exit).toHaveBeenCalledWith(42);
  });

  it("should handle remote error event", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: [mockHost] }), {
        headers: { "content-type": "application/json" },
      });

    const sseBody = buildSseBody([
      'data: {"type":"error","message":"Host unreachable"}',
    ]);

    pool
      .intercept({
        path: `/api/v1/opencomputers/hosts/${mockHost.id}/jobs`,
        method: "POST",
      })
      .reply(200, sseBody, {
        headers: { "content-type": "text/event-stream" },
      });

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "exec",
      "my-mac",
      "unreachable",
    ]);

    expect(errored.join(" ")).toContain("Host unreachable");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
