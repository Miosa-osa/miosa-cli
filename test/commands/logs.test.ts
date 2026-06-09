import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

vi.mock("../../src/commands/project.js", () => ({
  resolveDeploymentId: vi.fn(async () => "dep_linked"),
}));

const { register } = await import("../../src/commands/logs.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa logs", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters sandbox logs with --contains and --lines in JSON mode", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/logs",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          logs: [
            { line: "booting" },
            { line: "ready on :3000", timestamp: "2026-06-08T00:00:00Z" },
            { line: "ready on :5173", timestamp: "2026-06-08T00:00:01Z" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "logs",
      "--sandbox",
      "sbx_123",
      "--contains",
      "ready",
      "--lines",
      "1",
      "--json",
    ]);

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      ok: true,
      count: 1,
      logs: [{ line: "ready on :5173" }],
    });
  });

  it("supports explicit deployment logs with regex filters", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123/logs",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            { log: "200 /", ts: "2026-06-08T00:00:00Z" },
            { log: "500 /api/build", ts: "2026-06-08T00:00:01Z" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "logs",
      "--deployment",
      "dep_123",
      "--regex",
      "500|panic",
      "--json",
    ]);

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      ok: true,
      count: 1,
      logs: [{ line: "500 /api/build" }],
    });
  });
});
