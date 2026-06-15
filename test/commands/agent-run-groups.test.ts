import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const calls: Array<{ method: string; path: string; body?: unknown }> = [];

vi.mock("../../src/commands/enterprise-util.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/commands/enterprise-util.js")>();
  return {
    ...original,
    client: () => ({
      apiGet: async (path: string) => {
        calls.push({ method: "GET", path });
        if (path.includes("?")) {
          return { data: [{ id: "grp_1", name: "fanout", status: "running", counts: { total: 1 } }] };
        }
        return { data: { id: "grp_1", name: "fanout", status: "running", runs: [] } };
      },
      apiPost: async (path: string, body: unknown) => {
        calls.push({ method: "POST", path, body });
        return { data: { id: "grp_1", name: "fanout", status: "running", results: [] } };
      },
    }),
  };
});

const { register } = await import("../../src/commands/agent-run-groups.js");

describe("miosa agent-run-groups", () => {
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
      "agent-run-groups",
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
      "agent-run-groups",
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
      path: "/api/v1/agent-run-groups",
      body: { name: "fanout", workspace_id: "wk_1", concurrency_limit: 10 },
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      path: "/api/v1/agent-run-groups?workspace_id=wk_1&status=running&limit=20",
    });
  });

  it("shows, dispatches, and cancels groups", async () => {
    await program().parseAsync([
      "node",
      "miosa",
      "agent-run-groups",
      "show",
      "grp_1",
      "--runs",
    ]);

    await program().parseAsync([
      "node",
      "miosa",
      "agent-run-groups",
      "dispatch",
      "grp_1",
      "--run",
      '{"sandbox_id":"sbx_1","provider":"claude","prompt":"build"}',
      "--async",
    ]);

    await program().parseAsync(["node", "miosa", "agent-run-groups", "cancel", "grp_1"]);

    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/agent-run-groups/grp_1?include=runs",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/agent-run-groups/grp_1/dispatch",
      body: {
        runs: [{ sandbox_id: "sbx_1", provider: "claude", prompt: "build" }],
        async: true,
      },
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/api/v1/agent-run-groups/grp_1/cancel",
    });
  });
});
