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

const { register } = await import("../../src/commands/sandbox.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa sandbox exec", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("honors --cwd even when the API only executes the command string", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      command: "cd '/workspace' && pwd",
      cwd: "/workspace",
      dir: "/workspace",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
        body: expectedBody,
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "/workspace\n" } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_123",
      "--cwd",
      "/workspace",
      "pwd",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});
