import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
}));

const { register } = await import("../../src/commands/agent-runtime-profiles.js");

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

describe("miosa agent-runtime-profiles", () => {
  beforeEach(() => {
    process.env["MIOSA_JSON"] = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("lists, creates, updates, and deletes runtime profiles", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runtime-profiles?workspace_id=workspace_1",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "arp_123",
              name: "Claude builder",
              runtime: "claude-code",
              workspace_id: "workspace_1",
              is_default: true,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/agent-runtime-profiles",
        method: "POST",
        body: JSON.stringify({
          name: "Claude builder",
          runtime: "claude-code",
          workspace_id: "workspace_1",
          applies_to: ["sandbox", "computer"],
          tools: ["shell", "files"],
          env: { NODE_ENV: "test" },
          is_default: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "arp_123",
            name: "Claude builder",
            runtime: "claude-code",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/agent-runtime-profiles/arp_123",
        method: "PUT",
        body: JSON.stringify({ runtime: "codex" }),
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "arp_123", name: "Claude builder", runtime: "codex" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/agent-runtime-profiles/arp_123",
        method: "DELETE",
      })
      .reply(204, "");

    const logged = captureLogs();
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "agent-runtime-profiles",
      "list",
      "--workspace",
      "workspace_1",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runtime-profiles",
      "create",
      "--name",
      "Claude builder",
      "--runtime",
      "claude-code",
      "--workspace",
      "workspace_1",
      "--applies-to",
      "sandbox,computer",
      "--tools",
      "shell,files",
      "--env",
      '{"NODE_ENV":"test"}',
      "--default",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runtime-profiles",
      "update",
      "arp_123",
      "--runtime",
      "codex",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "agent-runtime-profiles",
      "delete",
      "arp_123",
    ]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({ id: "arp_123" });
    expect(outputs[1]).toMatchObject({ id: "arp_123", runtime: "claude-code" });
    expect(outputs[2]).toMatchObject({ id: "arp_123", runtime: "codex" });
    expect(outputs[3]).toEqual({ ok: true, id: "arp_123" });
  });
});
