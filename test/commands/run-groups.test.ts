import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";

const calls: Array<{ method: string; path: string; body?: unknown }> = [];

vi.mock("../../src/commands/enterprise-util.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/commands/enterprise-util.js")>();
  return {
    ...original,
    client: () => ({
      apiGet: async (path: string) => {
        calls.push({ method: "GET", path });
        if (path.endsWith("/activity")) {
          return { data: [{ id: "evt_1", type: "created", run_id: "run_1" }] };
        }
        if (path.includes("grp_done")) {
          return { data: { id: "grp_done", name: "fanout", status: "succeeded", runs: [] } };
        }
        if (path.includes("grp_files")) {
          return {
            data: {
              id: "grp_files",
              name: "fanout",
              status: "succeeded",
              runs: [{ id: "run_1", status: "succeeded" }],
            },
          };
        }
        if (path === "/api/v1/runs/run_1/files") {
          return {
            data: [
              {
                id: "art_1",
                run_id: "run_1",
                path: "/workspace/report.html",
                kind: "html",
              },
            ],
          };
        }
        if (path.includes("?")) {
          return { data: [{ id: "grp_1", name: "fanout", status: "running", counts: { total: 1 } }] };
        }
        return { data: { id: "grp_1", name: "fanout", status: "running", runs: [] } };
      },
      apiGetBinary: async (path: string) => {
        calls.push({ method: "GET_BINARY", path });
        return Buffer.from("<html>report</html>");
      },
      apiPost: async (path: string, body: unknown) => {
        calls.push({ method: "POST", path, body });
        return { data: { id: "grp_1", name: "fanout", status: "running", results: [] } };
      },
      apiStream: async (path: string) => {
        calls.push({ method: "STREAM", path });
        throw new Error("not used in this test");
      },
    }),
  };
});

const { register } = await import("../../src/commands/run-groups.js");

describe("miosa run-groups", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls.length = 0;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function program() {
    const command = new Command();
    command.exitOverride();
    register(command);
    return command;
  }

  it("creates and lists groups", async () => {
    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "create",
      "--name",
      "fanout",
      "--workspace",
      "wk_1",
      "--concurrency",
      "10",
      "--json",
    ]);

    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "list",
      "--workspace",
      "wk_1",
      "--status",
      "running",
      "--limit",
      "20",
      "--json",
    ]);

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/run-groups",
      body: { name: "fanout", workspace_id: "wk_1", concurrency_limit: 10 },
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      path: "/api/v1/run-groups?workspace_id=wk_1&status=running&limit=20",
    });
  });

  it("shows, dispatches, and cancels groups", async () => {
    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "show",
      "grp_1",
      "--runs",
    ]);

    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "dispatch",
      "grp_1",
      "--run",
      '{"sandbox_id":"sbx_1","runner":"claude-code","instruction":"build"}',
      "--async",
    ]);

    await program().parseAsync(["node", "miosa", "run-groups", "cancel", "grp_1"]);

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/run-groups/grp_1?include=runs",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/run-groups/grp_1/dispatch",
      body: {
        runs: [{ sandbox_id: "sbx_1", runner: "claude-code", instruction: "build" }],
        async: true,
      },
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/api/v1/run-groups/grp_1/cancel",
    });
  });

  it("lists group activity", async () => {
    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "activity",
      "grp_1",
      "--json",
    ]);

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/run-groups/grp_1/activity",
    });
  });

  it("lists and downloads group files", async () => {
    const writeFile = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as never);

    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "files",
      "grp_files",
      "--json",
    ]);

    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "files",
      "grp_files",
      "--download-dir",
      "/tmp/miosa-files",
      "--json",
    ]);

    expect(calls).toContainEqual({
      method: "GET",
      path: "/api/v1/run-groups/grp_files?include=runs",
    });
    expect(calls).toContainEqual({
      method: "GET",
      path: "/api/v1/runs/run_1/files",
    });
    expect(calls).toContainEqual({
      method: "GET_BINARY",
      path: "/api/v1/runs/run_1/files/art_1/download",
    });
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/miosa-files/run_1/workspace/report.html",
      Buffer.from("<html>report</html>"),
    );
  });

  it("waits for group completion", async () => {
    await program().parseAsync([
      "node",
      "miosa",
      "run-groups",
      "wait",
      "grp_done",
      "--runs",
      "--json",
    ]);

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/run-groups/grp_done?include=runs",
    });
  });
});
