import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { register } = await import("../../src/commands/app.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  path.join(__dirname, "..", "fixtures", name);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function runJson(args: string[]): Promise<unknown> {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  });
  const program = buildProgram();
  await program.parseAsync(["node", "miosa", ...args]);
  return JSON.parse(logged.join(""));
}

describe("miosa app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("inspects a Next.js app with compact agent context", async () => {
    const payload = (await runJson([
      "app",
      "inspect",
      fixture("nextjs"),
      "--json",
    ])) as {
      ok: boolean;
      data: {
        framework: { id: string };
        recommendation: { deployment: string; template: string };
        runtime: { port: number; env_keys: string[] };
        commands: { build: string; start: string };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.framework.id).toBe("nextjs");
    expect(payload.data.recommendation.deployment).toBe("docker_deploy");
    expect(payload.data.recommendation.template).toBe("nextjs");
    expect(payload.data.runtime.port).toBe(3000);
    expect(payload.data.commands.build).toBe("npm run build");
    expect(payload.data.commands.start).toBe("npm start");
  });

  it("plans an agent-safe Docker Deploy sequence for Next.js", async () => {
    const payload = (await runJson([
      "app",
      "plan",
      fixture("nextjs"),
      "--goal",
      "docker-deploy",
      "--slug",
      "clinic-app",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        recommended_deploy: string;
        steps: Array<{ id: string; command: string; json: boolean }>;
        edge_cases: Array<{ code: string; recovery: string[] }>;
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.recommended_deploy).toBe("docker_deploy");
    expect(payload.data.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining(["auth_health", "sandbox_deploy", "publish"]),
    );
    expect(payload.data.steps.every((step) => step.json || step.id === "production_probe")).toBe(true);
    expect(payload.data.steps.find((step) => step.id === "publish")?.command).toContain(
      "--docker-deploy",
    );
    expect(payload.data.steps.find((step) => step.id === "publish")?.command).toContain(
      "--timeout 900",
    );
    expect(payload.data.edge_cases.map((edge) => edge.code)).toContain(
      "PORT_NOT_LISTENING",
    );
  });
});
