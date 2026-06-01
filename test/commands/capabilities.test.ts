import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";

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

    expect(manifest.schema_version).toBe("2026-06-01");
    expect(manifest.cli.agent_entrypoint).toBe("miosa capabilities --json");
    expect(manifest.cli.global_env).toContain("MIOSA_JSON=1");
    expect(manifest.contract.errors.shape).toBeTruthy();
    expect(manifest.resources.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "sandbox",
        "computer",
        "deployment_app",
        "database",
        "workspace",
      ]),
    );
    expect(manifest.workflows.map((w) => w.id)).toEqual(
      expect.arrayContaining([
        "auth_health",
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
});
