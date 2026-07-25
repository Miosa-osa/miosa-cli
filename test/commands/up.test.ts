import { afterEach, describe, expect, it, vi } from "vitest";
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

const { register } = await import("../../src/commands/up.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa up --computer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("creates the default desktop and accepts direct API envelopes", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/computers",
        method: "POST",
        body: JSON.stringify({
          name: "boris",
          template_type: "miosa-desktop",
          os: "ubuntu",
          size: "small",
          desktop: true,
        }),
      })
      .reply(
        201,
        JSON.stringify({
          id: "cmp_boris",
          name: "boris",
          status: "provisioning",
          desktop_url: "https://boris.computer.miosa.ai/viewer",
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/computers/cmp_boris",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          id: "cmp_boris",
          name: "boris",
          status: "running",
          desktop_url: "https://boris.computer.miosa.ai/viewer",
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "up",
      "--computer",
      "--yes",
      "--json",
      "--name",
      "boris",
    ]);

    expect(JSON.parse(logged.at(-1) ?? "{}")).toEqual({
      id: "cmp_boris",
      name: "boris",
      state: "running",
      url: "https://boris.computer.miosa.ai/viewer",
    });
  });
});
