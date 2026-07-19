import { describe, it, expect, vi, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
    tenant: null,
    workspace: null,
    quiet: false,
    debug: false,
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
}));

vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const { register } = await import("../../src/commands/databases.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const DB_ID = "db-0000-0000-0000-000000000001";
const WORKSPACE_ID = "ws-0000-0000-0000-000000000001";

function captureLogs(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  return logged;
}

describe("miosa databases create", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends explicit workspace_id and can wait for connection-ready state", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/databases",
        method: "POST",
        body: JSON.stringify({
          name: "agent-pg",
          engine: "postgresql",
          engine_version: "16",
          workspace_id: WORKSPACE_ID,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          id: DB_ID,
          name: "agent-pg",
          engine: "postgresql",
          engine_version: "16",
          state: "provisioning",
          workspace_id: WORKSPACE_ID,
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          id: DB_ID,
          name: "agent-pg",
          engine: "postgresql",
          engine_version: "16",
          state: "running",
          workspace_id: WORKSPACE_ID,
          proxy_status: "ready",
          connection_test: {
            status: "ok",
            host: "10.10.0.5",
            port: 5432,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "databases",
      "create",
      "--name",
      "agent-pg",
      "--engine",
      "postgres",
      "--workspace",
      WORKSPACE_ID,
      "--wait",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["state"]).toBe("running");
    expect(parsed["workspace_id"]).toBe(WORKSPACE_ID);
    expect(parsed["connection_test"]).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
  });
});

describe("miosa databases lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["start", "stop", "restart"] as const)(
    "posts to the %s endpoint",
    async (action) => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({
          path: `/api/v1/databases/${DB_ID}/${action}`,
          method: "POST",
          body: JSON.stringify({}),
        })
        .reply(
          200,
          JSON.stringify({
            id: DB_ID,
            state: action === "stop" ? "stopped" : "provisioning",
          }),
          { headers: { "content-type": "application/json" } },
        );

      const logged = captureLogs();
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "miosa",
        "databases",
        action,
        DB_ID,
        "--json",
      ]);

      const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
      expect(parsed["id"]).toBe(DB_ID);
    },
  );
});

describe("miosa databases wait", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns when the database connection test is OK", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          id: DB_ID,
          state: "running",
          connection_test: {
            status: "ok",
            host: "10.10.0.5",
            port: 5432,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "databases",
      "wait",
      DB_ID,
      "--ready",
      "--timeout",
      "120",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["state"]).toBe("running");
    expect(parsed["connection_test"]).toEqual(
      expect.objectContaining({ status: "ok" }),
    );
  });
});

describe("miosa databases metrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches database metrics as raw JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/metrics?window=1h`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          resource_type: "database",
          database_id: DB_ID,
          window: "1h",
          current: {
            state: "running",
            engine: "postgresql",
            engine_version: "15",
            memory_mb: 2048,
          },
          series: { cpu_percent: [], memory_mb: [] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "databases",
      "metrics",
      DB_ID,
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as Record<string, unknown>;
    expect(parsed["resource_type"]).toBe("database");
    expect(parsed["current"]).toEqual(
      expect.objectContaining({ state: "running", engine: "postgresql" }),
    );
  });
});

describe("miosa databases logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the recent logs endpoint by default", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/logs?lines=50`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            database_id: DB_ID,
            logs: [{ t: "2026-06-01T00:00:00Z", line: "postgres ready" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "databases",
      "logs",
      DB_ID,
      "--lines",
      "50",
    ]);

    expect(logged.join("\n")).toContain("postgres ready");
  });
});
