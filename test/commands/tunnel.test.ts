import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import { createConnection } from "node:net";

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
    fail: vi.fn(),
  }),
  ora: vi.fn(),
}));

// Mock WebSocket — tunnel forward uses it for the proxy connection
vi.mock("ws", () => {
  const EventEmitter = require("node:events");
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    close = vi.fn(() => {
      this.emit("close");
    });
    constructor() {
      super();
      // Emit open asynchronously to allow listeners to be attached first
      setImmediate(() => this.emit("open"));
    }
  }
  return { WebSocket: MockWebSocket, default: MockWebSocket };
});

const { register } = await import("../../src/commands/tunnel.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

// ── port-spec parser (tested via CLI arg parsing) ──────────────────────────

describe("tunnel forward — port spec parsing", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject missing ports with exit(1)", async () => {
    // parseAsync with exitOverride() throws on --help/--version, but
    // our action calls process.exit directly for missing ports
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // The computer GET will not be reached; we exit early
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "tunnel",
      "forward",
      "comp-xyz",
    ]);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should reject an invalid port spec", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers/comp-xyz", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "comp-xyz" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "tunnel",
      "forward",
      "comp-xyz",
      "notaport",
    ]);

    // Invalid port → handleError → process.exit
    expect(process.exit).toHaveBeenCalledWith(expect.any(Number));
  });
});

// ── existing host tunnel subcommands (regression) ─────────────────────────

describe("tunnel open / list / close (host tunnels)", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should list tunnels for a host and render a table", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "host-001",
              name: "my-mac",
              state: "online",
              os: null,
              platform: null,
              arch: null,
              hostname: null,
              last_heartbeat: null,
              host_key: null,
              install_command: null,
              tenant_id: "t_1",
              inserted_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/opencomputers/hosts/host-001/tunnels",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              slug: "abc123",
              port: 3000,
              public_url: "https://abc123.tunnel.miosa.ai",
              state: "active",
              inserted_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tunnel", "list", "my-mac"]);

    const output = logged.join("\n");
    expect(output).toContain("abc123");
    expect(output).toContain("3000");
  });

  it("should print dim message when host has no tunnels", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "host-001",
              name: "my-mac",
              state: "online",
              os: null,
              platform: null,
              arch: null,
              hostname: null,
              last_heartbeat: null,
              host_key: null,
              install_command: null,
              tenant_id: "t_1",
              inserted_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/opencomputers/hosts/host-001/tunnels",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tunnel", "list", "my-mac"]);

    expect(logged.join(" ")).toContain("No tunnels");
  });

  it("should output JSON for tunnel list with --json", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "host-001",
              name: "my-mac",
              state: "online",
              os: null,
              platform: null,
              arch: null,
              hostname: null,
              last_heartbeat: null,
              host_key: null,
              install_command: null,
              tenant_id: "t_1",
              inserted_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/opencomputers/hosts/host-001/tunnels",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              slug: "abc123",
              port: 3000,
              public_url: "https://abc123.tunnel.miosa.ai",
              state: "active",
              inserted_at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "tunnel",
      "list",
      "my-mac",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Poll until the given TCP port on localhost is reachable (server is up),
 * then resolve. Rejects after `timeoutMs` if the port never opens.
 */
function waitForPort(port: number, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt(): void {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() < deadline) {
          setTimeout(attempt, 20);
        } else {
          reject(new Error(`Port ${port} not reachable after ${timeoutMs}ms`));
        }
      });
    }

    attempt();
  });
}

// ── forward: happy-path TCP proxy ─────────────────────────────────────────

describe("tunnel forward — TCP proxy", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should start a TCP server and emit JSON tunnel map with --json", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers/comp-xyz", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "comp-xyz" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    // Use port 19432 — unique to this test to avoid conflicts
    const LOCAL_PORT = 19432;

    const forwardPromise = (async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "tunnel",
        "forward",
        "comp-xyz",
        `15432:${LOCAL_PORT}`,
        "--json",
      ]);
    })();

    // Wait until the TCP server is actually listening, then send SIGINT
    await waitForPort(LOCAL_PORT);
    process.emit("SIGINT");
    await forwardPromise.catch(() => {});

    const jsonLine = logged.find((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Array<{
      remote_port: number;
      local_port: number;
    }>;
    expect(parsed[0]?.remote_port).toBe(15432);
    expect(parsed[0]?.local_port).toBe(LOCAL_PORT);
  }, 10_000);

  it("should print a human-readable tunnel line without --json", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers/comp-xyz", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "comp-xyz" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const LOCAL_PORT = 19433;

    const forwardPromise = (async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "tunnel",
        "forward",
        "comp-xyz",
        String(LOCAL_PORT),
      ]);
    })();

    await waitForPort(LOCAL_PORT);
    process.emit("SIGINT");
    await forwardPromise.catch(() => {});

    const output = logged.join("\n");
    expect(output).toContain("comp-xyz");
    expect(output).toContain(String(LOCAL_PORT));
    expect(output).toContain("localhost");
  }, 10_000);

  it("should accept remote:local port spec via --local-port", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers/comp-xyz", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "comp-xyz" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const LOCAL_PORT = 19434;

    const forwardPromise = (async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "tunnel",
        "forward",
        "comp-xyz",
        "5432",
        "--local-port",
        String(LOCAL_PORT),
        "--json",
      ]);
    })();

    await waitForPort(LOCAL_PORT);
    process.emit("SIGINT");
    await forwardPromise.catch(() => {});

    const jsonLine = logged.find((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as Array<{
      remote_port: number;
      local_port: number;
    }>;
    expect(parsed[0]?.remote_port).toBe(5432);
    expect(parsed[0]?.local_port).toBe(LOCAL_PORT);
  }, 10_000);

  it("should report EADDRINUSE when local port is taken", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers/comp-xyz", method: "GET" })
      .reply(200, JSON.stringify({ data: { id: "comp-xyz" } }), {
        headers: { "content-type": "application/json" },
      });

    // Occupy port 19435 so the forward attempt collides
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(19435, "127.0.0.1", resolve),
    );

    try {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "tunnel",
        "forward",
        "comp-xyz",
        "5432:19435",
      ]);

      // handleError calls process.exit
      expect(process.exit).toHaveBeenCalledWith(expect.any(Number));
    } finally {
      blocker.close();
    }
  });
});
