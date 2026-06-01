import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

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

const { register } = await import("../../src/commands/agent.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const computer = {
  id: "comp-0000-0000-0000-000000000001",
  name: "my-mac",
  status: "running",
};

const session = {
  id: "sess-0000-0000-0000-000000000001",
  computer_id: computer.id,
  status: "running",
  goal: "run the tests",
};

describe("miosa agent", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("starts a computer agent session with the Orgo-style shortcut", async () => {
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
        path: `/api/v1/computers/${computer.id}/cua/sessions`,
        method: "POST",
        body: JSON.stringify({ goal: "run the tests" }),
      })
      .reply(201, JSON.stringify({ data: session }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "agent", "my-mac", "run", "the", "tests"]);

    expect(logged.join("\n")).toContain(session.id);
    expect(logged.join("\n")).toContain("Resume:");
  });

  it("honors MIOSA_JSON for agent output", async () => {
    process.env["MIOSA_JSON"] = "1";
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
        path: `/api/v1/computers/${computer.id}/cua/sessions`,
        method: "POST",
        body: JSON.stringify({ goal: "run the tests" }),
      })
      .reply(201, JSON.stringify({ data: session }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "agent", "my-mac", "run", "the", "tests"]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: session.id,
      goal: "run the tests",
    });
  });

  it("resumes a session from the shortcut command", async () => {
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
        path: `/api/v1/computers/${computer.id}/cua/sessions/${session.id}/resume`,
        method: "POST",
        body: JSON.stringify({}),
      })
      .reply(200, JSON.stringify({ data: { ...session, status: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/cua/sessions/${session.id}/task`,
        method: "POST",
        body: JSON.stringify({ instruction: "continue the fix" }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
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
      "agent",
      "my-mac",
      "--resume",
      session.id,
      "continue",
      "the",
      "fix",
    ]);

    expect(logged.join("\n")).toContain(`Session ${session.id} resumed.`);
    expect(logged.join("\n")).toContain("Task submitted");
  });
});

