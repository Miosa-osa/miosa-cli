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
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

// Prevent actual psql from launching
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    on: vi.fn(),
  })),
}));

// Prevent interactive prompts from blocking
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const { register } = await import("../../src/commands/db.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const DB_ID = "db-0000-0000-0000-000000000001";
const BACKUP_ID = "bk-0000-0000-0000-000000000001";

const mockCredentials = {
  url: "postgres://admin:secret@db.miosa.ai:5432/mydb",
  host: "db.miosa.ai",
  port: 5432,
  database: "mydb",
  username: "admin",
  password: "secret",
};

const mockBackup = {
  id: BACKUP_ID,
  database_id: DB_ID,
  state: "creating",
  size_bytes: null,
  created_at: "2026-05-21T00:00:00Z",
};

const mockRestore = {
  id: "rst-0000-0000-0000-000000000001",
  database_id: DB_ID,
  backup_id: BACKUP_ID,
  state: "pending",
  started_at: null,
};

// ── db connect --print-url ────────────────────────────────────────────────────

describe("miosa db connect --print-url", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should print the connection URL", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/credentials`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockCredentials }), {
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
      "db",
      "connect",
      DB_ID,
      "--print-url",
    ]);

    expect(logged.join("\n")).toContain("postgres://");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should output JSON credentials with --json flag", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/credentials`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: mockCredentials }), {
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
      "db",
      "connect",
      DB_ID,
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as typeof mockCredentials;
    expect(parsed.host).toBe("db.miosa.ai");
    expect(parsed.username).toBe("admin");
  });

  it("should error on 404", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/credentials`,
        method: "GET",
      })
      .reply(404, JSON.stringify({ error: { message: "Not found" } }), {
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
      "db",
      "connect",
      DB_ID,
      "--print-url",
    ]);

    expect(errored.join(" ")).toMatch(/not found/i);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

// ── db backup ─────────────────────────────────────────────────────────────────

describe("miosa db backup", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should trigger a backup and display the backup ID", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/backups`,
        method: "POST",
      })
      .reply(201, JSON.stringify({ data: mockBackup }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "db", "backup", DB_ID]);

    const output = logged.join("\n");
    expect(output).toContain(BACKUP_ID.slice(0, 12));
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should output raw JSON with --json flag", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/backups`,
        method: "POST",
      })
      .reply(201, JSON.stringify({ data: mockBackup }), {
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
      "db",
      "backup",
      DB_ID,
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as typeof mockBackup;
    expect(parsed.id).toBe(BACKUP_ID);
    expect(parsed.state).toBe("creating");
  });
});

// ── db restore ────────────────────────────────────────────────────────────────

describe("miosa db restore", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initiate a restore with --force and display restore ID", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/restores`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockRestore }), {
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
      "db",
      "restore",
      DB_ID,
      "--backup",
      BACKUP_ID,
      "--force",
    ]);

    const output = logged.join("\n");
    expect(output).toContain(mockRestore.id.slice(0, 12));
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("should output raw JSON with --json --force flags", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/restores`,
        method: "POST",
      })
      .reply(202, JSON.stringify({ data: mockRestore }), {
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
      "db",
      "restore",
      DB_ID,
      "--backup",
      BACKUP_ID,
      "--force",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as typeof mockRestore;
    expect(parsed.backup_id).toBe(BACKUP_ID);
    expect(parsed.database_id).toBe(DB_ID);
  });

  it("should error on 404 database not found", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1/databases/${DB_ID}/restores`,
        method: "POST",
      })
      .reply(
        404,
        JSON.stringify({ error: { message: "Database not found" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    const errored: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errored.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "db",
      "restore",
      DB_ID,
      "--backup",
      BACKUP_ID,
      "--force",
    ]);

    expect(errored.join(" ")).toMatch(/not found/i);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
