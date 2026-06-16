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

const { register } = await import("../../src/commands/runtime-env.js");

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

describe("miosa runtime-env", () => {
  beforeEach(() => {
    process.env["MIOSA_JSON"] = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("sets, lists, shows, and unsets inherited runtime env vars", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/runtime-env",
        method: "POST",
        body: JSON.stringify({
          scope: "workspace",
          workspace_id: "workspace_1",
          project_id: undefined,
          target: "deployment",
          name: "ANTHROPIC_API_KEY",
          value: "sk-ant-test",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "env_123",
            scope: "workspace",
            workspace_id: "workspace_1",
            target: "deployment",
            name: "ANTHROPIC_API_KEY",
            preview: "sk-ant...test",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/runtime-env?scope=workspace&workspace_id=workspace_1&target=deployment",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "env_123",
              scope: "workspace",
              workspace_id: "workspace_1",
              target: "deployment",
              name: "ANTHROPIC_API_KEY",
              preview: "sk-ant...test",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/runtime-env/env_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "env_123",
            scope: "workspace",
            target: "deployment",
            name: "ANTHROPIC_API_KEY",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    pool
      .intercept({
        path: "/api/v1/runtime-env/env_123",
        method: "DELETE",
      })
      .reply(204, "");

    const logged = captureLogs();
    const program = buildProgram();

    await program.parseAsync([
      "node",
      "miosa",
      "runtime-env",
      "set",
      "ANTHROPIC_API_KEY=sk-ant-test",
      "--scope",
      "workspace",
      "--workspace",
      "workspace_1",
      "--target",
      "deployment",
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "runtime-env",
      "list",
      "--scope",
      "workspace",
      "--workspace",
      "workspace_1",
      "--target",
      "deployment",
    ]);
    await program.parseAsync(["node", "miosa", "runtime-env", "show", "env_123"]);
    await program.parseAsync(["node", "miosa", "runtime-env", "unset", "env_123"]);

    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0][0]).toMatchObject({
      id: "env_123",
      name: "ANTHROPIC_API_KEY",
    });
    expect(outputs[1][0]).toMatchObject({ id: "env_123", target: "deployment" });
    expect(outputs[2]).toMatchObject({ id: "env_123", scope: "workspace" });
    expect(outputs[3]).toEqual({ ok: true, deleted: 1 });
  });
});
