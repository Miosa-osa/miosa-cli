import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

// ── shared mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
  }),
  saveConfig: vi.fn(),
  clearApiKey: vi.fn(),
  saveAuthCache: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

const { register } = await import("../../src/commands/tenant.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const mockTenants = [
  {
    id: "ten-0000-0000-0000-000000000001",
    name: "Acme Corp",
    slug: "acme",
    plan: "pro",
    credit_balance: 5000,
    region: "us-east",
  },
  {
    id: "ten-0000-0000-0000-000000000002",
    name: "Beta LLC",
    slug: "beta",
    plan: "starter",
    credit_balance: 100,
    region: null,
  },
];

// ── tenant list ───────────────────────────────────────────────────────────────

describe("miosa tenant list", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should list tenants in table format", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: mockTenants }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tenant", "list"]);

    const output = logged.join("\n");
    expect(output).toContain("Acme Corp");
    expect(output).toContain("acme");
    expect(output).toContain("pro");
  });

  it("should output raw JSON with --json flag", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: mockTenants }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tenant", "list", "--json"]);

    const parsed = JSON.parse(logged.join("")) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("should show empty message when no tenants returned", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tenant", "list"]);

    expect(logged.join("\n")).toContain("No tenants");
  });

  it("should error on 401", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(401, JSON.stringify({ error: { message: "Unauthorized" } }), {
        headers: { "content-type": "application/json" },
      });

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tenant", "list"]);

    expect(errored.join(" ")).toMatch(/auth|denied|authorized/i);
    expect(process.exit).toHaveBeenCalledWith(3);
  });
});

// ── tenant switch ─────────────────────────────────────────────────────────────

describe("miosa tenant switch", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should switch to a valid tenant slug", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: mockTenants }), {
        headers: { "content-type": "application/json" },
      });

    const { saveConfig } = await import("../../src/config.js");

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "tenant", "switch", "acme"]);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ default_host: "acme" }),
    );
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should exit 1 when slug is not found", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: mockTenants }), {
        headers: { "content-type": "application/json" },
      });

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "tenant",
      "switch",
      "nonexistent-slug",
    ]);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should output JSON when --json flag is passed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: mockTenants }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "tenant",
      "switch",
      "acme",
      "--json",
    ]);

    const output = logged.join("");
    expect(output).toContain("tenant_id");
    expect(output).toContain("acme");
  });
});
