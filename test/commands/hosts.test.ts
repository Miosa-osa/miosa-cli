import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import type { Host } from "../../src/types.js";

// Mock config so tests don't touch ~/.miosa
vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  saveConfig: vi.fn(),
  redactKey: (k: string | null) => (k ? "msk_u_***" : "(none)"),
  getConfigPath: () => "/tmp/.miosa/config.json",
}));

const { register } = await import("../../src/commands/hosts.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  register(program);
  return program;
}

const mockHosts: Host[] = [
  {
    id: "abc12345-0000-0000-0000-000000000000" as import("../../src/types.js").HostId,
    name: "my-mac",
    state: "online",
    os: "macOS",
    platform: "darwin",
    arch: "arm64",
    hostname: "Roberts-MBP.local",
    last_heartbeat: new Date().toISOString(),
    host_key: null,
    install_command: null,
    tenant_id: "t_123" as import("../../src/types.js").TenantId,
    inserted_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "def67890-0000-0000-0000-000000000000" as import("../../src/types.js").HostId,
    name: "work-linux",
    state: "offline",
    os: "Ubuntu 22.04",
    platform: "linux",
    arch: "x86_64",
    hostname: "workstation",
    last_heartbeat: new Date(Date.now() - 3_600_000).toISOString(),
    host_key: null,
    install_command: null,
    tenant_id: "t_123" as import("../../src/types.js").TenantId,
    inserted_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
];

describe("miosa hosts", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  it("should output JSON when --json flag is passed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: mockHosts }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "hosts", "--json"]);

    const output = logged.join("\n");
    const parsed = JSON.parse(output) as Host[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.name).toBe("my-mac");
    expect(parsed[1]?.name).toBe("work-linux");
  });

  it("should render a table when no flags are passed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: mockHosts }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "hosts"]);

    const output = logged.join("\n");
    // Table should contain host names
    expect(output).toContain("my-mac");
    expect(output).toContain("work-linux");
    // Table should have headers
    expect(output).toMatch(/NAME/i);
    expect(output).toMatch(/STATE/i);
  });

  it("should display empty message when no hosts", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "hosts"]);

    const output = logged.join("\n");
    expect(output).toContain("miosa connect");
  });

  it("should show short IDs (8 chars) in table output", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
      .reply(200, JSON.stringify({ data: mockHosts }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "hosts"]);

    const output = logged.join("\n");
    // Short ID is first 8 chars of UUID
    expect(output).toContain("abc12345");
    expect(output).toContain("def67890");
    // Full UUID should NOT appear
    expect(output).not.toContain("abc12345-0000-0000-0000-000000000000");
  });
});
