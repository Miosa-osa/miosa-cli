import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

const configState = vi.hoisted(() => ({
  cache: {
    email: null,
    name: "Cached Tenant",
    slug: "cached",
    plan: "starter",
    credit_balance: 12,
    region: "us-east",
    cached_at: "2026-01-01T00:00:00.000Z",
  } as unknown,
  saveAuthCache: vi.fn(),
  clearAuthCache: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: "us-mia",
    output: "text",
    tenant: null,
    workspace: null,
    quiet: false,
    debug: false,
  }),
  loadAuthCache: () => configState.cache,
  saveAuthCache: configState.saveAuthCache,
  clearAuthCache: configState.clearAuthCache,
  redactKey: (key: string | null | undefined) =>
    key ? `${key.slice(0, 5)}...` : "(none)",
}));

const { register } = await import("../../src/commands/whoami.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa whoami", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    configState.cache = {
      email: null,
      name: "Cached Tenant",
      slug: "cached",
      plan: "starter",
      credit_balance: 12,
      region: "us-east",
      cached_at: "2026-01-01T00:00:00.000Z",
    };
    configState.saveAuthCache.mockClear();
    configState.clearAuthCache.mockClear();
    configState.clearAuthCache.mockImplementation(() => {
      configState.cache = null;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("verifies identity live by default even when a cache exists", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "tenant-live",
            name: "Live Tenant",
            slug: "live",
            plan: "pro",
            credit_balance: 500,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "whoami", "--json"]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["authenticated"]).toBe(true);
    expect(parsed["name"]).toBe("Live Tenant");
    expect(parsed["verified"]).toBe(true);
    expect(parsed["cached"]).toBe(false);
    expect(configState.saveAuthCache).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Live Tenant", slug: "live" }),
    );
  });

  it("only uses stale identity when --cached is explicit", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "whoami", "--cached", "--json"]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["authenticated"]).toBe(true);
    expect(parsed["name"]).toBe("Cached Tenant");
    expect(parsed["verified"]).toBe(false);
    expect(parsed["cached"]).toBe(true);
    expect(configState.saveAuthCache).not.toHaveBeenCalled();
  });

  it("clears stale identity cache when the API key is revoked", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
      .reply(
        401,
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "API key has been revoked",
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_revoked",
          },
        },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "whoami", "--json"]);

    const parsed = JSON.parse(logged.join("")) as {
      ok: boolean;
      error: { code: string; message: string; request_id?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AUTH");
    expect(parsed.error.message).toContain("API key has been revoked");
    expect(parsed.error.request_id).toBe("req_revoked");
    expect(configState.clearAuthCache).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(3);
  });
});
