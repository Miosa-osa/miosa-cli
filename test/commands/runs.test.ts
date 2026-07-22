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

const { register } = await import("../../src/commands/runs.js");

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

describe("miosa runs", () => {
  beforeEach(() => {
    process.env["MIOSA_JSON"] = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("lists, shows, and cancels runs", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/runs?external_workspace_id=clinic-iq&external_user_id=founder-1&external_project_id=landing-page&target_kind=sandbox&target_id=sbx_123&status=running",
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
              runner: "codex",
              instruction: "build it",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/runs/run_123",
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
        path: "/api/v1/runs/run_123/cancel",
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
      "runs",
      "list",
      "--sandbox",
      "sbx_123",
      "--status",
      "running",
      "--external-workspace",
      "clinic-iq",
      "--external-user",
      "founder-1",
      "--external-project",
      "landing-page",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "runs",
      "show",
      "run_123",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "runs",
      "cancel",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({ id: "run_123" });
    expect(outputs[1]).toMatchObject({ id: "run_123" });
    expect(outputs[2]).toMatchObject({ id: "run_123", status: "canceled" });
  });

  it("lists and downloads run files", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/runs/run_123/files",
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
        path: "/api/v1/runs/run_123/files/art_123/download",
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
      "runs",
      "files",
      "run_123",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "runs",
      "download-file",
      "run_123",
      "art_123",
      "--output",
      "report.html",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({ id: "art_123", kind: "html" });
    expect(outputs[1]).toMatchObject({
      run_id: "run_123",
      file_id: "art_123",
      output: "report.html",
      bytes: 19,
    });
    expect(writeFile).toHaveBeenCalledWith(
      "report.html",
      Buffer.from("<html>report</html>"),
    );
  });

  it("lists run activity", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/runs/run_123/activity",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "evt_123",
              run_id: "run_123",
              sequence: 1,
              type: "created",
              message: "Run created",
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
      "runs",
      "activity",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({
      id: "evt_123",
      run_id: "run_123",
      type: "created",
    });
  });

  it("waits for a run", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/runs/run_123",
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
      "runs",
      "wait",
      "run_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0]).toMatchObject({ id: "run_123", status: "succeeded" });
  });
});
