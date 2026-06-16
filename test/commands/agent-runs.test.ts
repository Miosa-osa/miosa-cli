import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
}));

const { register } = await import("../../src/commands/agent-runs.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function captureLogs(): string[] {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  return logged;
}

describe("miosa agent-runs", () => {
  beforeEach(() => {
    process.env["MIOSA_JSON"] = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("lists, shows, and cancels agent runs", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs?target_kind=sandbox&target_id=sbx_123&status=running",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "run_123",
              target_kind: "sandbox",
              target_id: "sbx_123",
              status: "running",
              provider: "codex",
              prompt: "build it",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            status: "running",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123/cancel",
        method: "POST",
        body: JSON.stringify({}),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "run_123",
            status: "canceled",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "list",
      "--sandbox",
      "sbx_123",
      "--status",
      "running",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "show",
      "run_123",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "cancel",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({ id: "run_123" });
    expect(outputs[1]).toMatchObject({ id: "run_123" });
    expect(outputs[2]).toMatchObject({ id: "run_123", status: "canceled" });
  });

  it("lists and downloads agent run artifacts", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123/artifacts",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "art_123",
              path: "/workspace/report.html",
              kind: "html",
              mime_type: "text/html",
              size_bytes: 19,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123/artifacts/art_123/download",
        method: "GET",
      })
      .reply(200, "<html>report</html>", {
        headers: { "content-type": "text/html" },
      });

    const logged = captureLogs();
    const writeFile = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "artifacts",
      "run_123",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "download",
      "run_123",
      "art_123",
      "--output",
      "report.html",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({ id: "art_123", kind: "html" });
    expect(outputs[1]).toMatchObject({
      agent_run_id: "run_123",
      artifact_id: "art_123",
      output: "report.html",
      bytes: 19,
    });
    expect(writeFile).toHaveBeenCalledWith(
      "report.html",
      Buffer.from("<html>report</html>"),
    );
  });

  it("lists agent run events", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123/events",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "evt_123",
              agent_run_id: "run_123",
              sequence: 1,
              type: "created",
              message: "Agent run created",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "events",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({
      id: "evt_123",
      agent_run_id: "run_123",
      type: "created",
    });
  });

  it("waits for an agent run", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            status: "succeeded",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "agent-runs",
      "wait",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0]).toMatchObject({ id: "run_123", status: "succeeded" });
  });
});
