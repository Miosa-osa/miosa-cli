import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const { register } = await import("../../src/commands/capabilities.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("prints an agent-readable JSON manifest", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "capabilities", "--json"]);

    const manifest = JSON.parse(logged.join("")) as {
      schema_version: string;
      cli: { agent_entrypoint: string; global_env: string[] };
      contract: { errors: { shape: unknown } };
      resources: Array<{ id: string }>;
      workflows: Array<{
        id: string;
        steps: Array<{ command: string; json: boolean }>;
      }>;
      probing: { docker_in_sandbox: unknown[] };
    };

    expect(manifest.schema_version).toBe("2026-07-23");
    expect(manifest.cli.agent_entrypoint).toBe("miosa capabilities --json");
    expect(manifest.cli.global_env).toContain("MIOSA_JSON=1");
    expect(manifest.contract.errors.shape).toBeTruthy();
    expect(manifest.resources.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "sandbox",
        "device",
        "connect_provider",
        "computer",
        "deployment_app",
        "database",
        "workspace",
      ]),
    );
    expect(manifest.workflows.map((w) => w.id)).toEqual(
      expect.arrayContaining([
        "auth_health",
        "choose_agent_device",
        "connect_provider_for_sandbox_agent",
        "runtime_token_api",
        "dockerfile_template_sandbox",
        "sandbox_preview",
        "publish_durable_app",
        "computer_agent_control",
        "safe_workspace_cleanup",
      ]),
    );
    expect(manifest.probing.docker_in_sandbox.length).toBeGreaterThan(0);
    expect(
      manifest.workflows
        .flatMap((workflow) => workflow.steps)
        .some((step) => step.command.includes("--json")),
    ).toBe(true);
    expect(JSON.stringify(manifest)).toContain("refero/design-research");
  });

  it("honors MIOSA_JSON=1 without an explicit flag", async () => {
    process.env["MIOSA_JSON"] = "1";
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "capabilities"]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      cli: { agent_entrypoint: "miosa capabilities --json" },
    });
  });

  it("fetches live backend runtime capabilities", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/runtime-capabilities", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: {
            version: 1,
            runs: {
              contract_fields: ["execution_packet", "expected_outputs"],
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "capabilities", "--live", "--json"]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      data: {
        version: 1,
        runs: {
          contract_fields: ["execution_packet", "expected_outputs"],
        },
      },
    });
  });
});
