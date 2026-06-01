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
}));

const { register } = await import("../../src/commands/cleanup.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa cleanup", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts dry-run cleanup filters to the workspace cleanup endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/workspaces/ws_123/cleanup",
        method: "POST",
        body: JSON.stringify({
          resource_type: "sandboxes",
          name_prefix: "ciq-smoke",
          older_than: "2h",
          limit: 10,
          dry_run: true,
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            dry_run: true,
            resources: { sandboxes: [{ id: "sbx_1" }] },
            counts: { sandboxes: 1 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "cleanup",
      "sandboxes",
      "--workspace",
      "ws_123",
      "--name-prefix",
      "ciq-smoke",
      "--older-than",
      "2h",
      "--limit",
      "10",
      "--dry-run",
      "--json",
    ]);

    const parsed = JSON.parse(logged.join("")) as {
      dry_run: boolean;
      resources: { sandboxes: Array<{ id: string }> };
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.resources.sandboxes[0]?.id).toBe("sbx_1");
  });
});
