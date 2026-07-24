import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_test",
    tenant: "osa",
    workspace: "ws_123",
  }),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({ stop: vi.fn(), succeed: vi.fn(), fail: vi.fn(), text: "" }),
}));

const sandboxMocks = vi.hoisted(() => ({
  deploySandbox: vi.fn(),
}));

vi.mock("../../src/commands/sandbox.js", () => sandboxMocks);

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
    sandboxMocks.deploySandbox.mockReset();
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
    expect(
      payload.data.steps.every(
        (step) => step.json || step.id === "production_probe",
      ),
    ).toBe(true);
    expect(
      payload.data.steps.find((step) => step.id === "publish")?.command,
    ).toContain("--docker-deploy");
    expect(
      payload.data.steps.find((step) => step.id === "publish")?.command,
    ).toContain("--timeout 900");
    expect(
      payload.data.steps.find((step) => step.id === "production_probe")
        ?.command,
    ).toContain("miosa docker-deploy doctor <deployment-id>");
    expect(payload.data.edge_cases.map((edge) => edge.code)).toContain(
      "PORT_NOT_LISTENING",
    );
    expect(payload.data.edge_cases.map((edge) => edge.code)).toContain(
      "DOCKER_DEPLOY_ROUTE_UNHEALTHY",
    );
  });

  it("doctors a durable App Document in the selected workspace", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/builder/apps/app_123",
        method: "GET",
      })
      .reply(200, {
        data: {
          id: "app_123",
          workspace_id: "ws_123",
          version_hash: "sha256:exact",
          version_approved: true,
          approval: { version_hash: "sha256:exact" },
          document: {
            format: "miosa-app/v1",
            view: { kind: "generated", source: "<main />" },
            capabilities: ["computer.exec"],
            connectors: ["github"],
            automations: [],
          },
        },
      });
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/builder/apps/app_123/diagnostics",
        method: "GET",
      })
      .reply(200, {
        data: {
          ok: true,
          issues: [],
          manifest: {
            capabilities: [
              {
                name: "computer.exec",
                version: "1.0.0",
                fingerprint: "sha256:exact",
              },
            ],
            connectors: [{ id: "connector_123", uid: "github" }],
            automations: [],
            collections: [],
            pins: [],
          },
        },
      });

    const payload = (await runJson([
      "app",
      "documents",
      "doctor",
      "app_123",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        workspace_id: string;
        version_hash: string;
        compiled_requirements: { connectors: Array<{ uid: string }> };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.workspace_id).toBe("ws_123");
    expect(payload.data.version_hash).toBe("sha256:exact");
    expect(payload.data.compiled_requirements.connectors[0]?.uid).toBe(
      "github",
    );
  });

  it("writes durable app data with an exact expected version", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/builder/apps/app_123/data/customers/customer-1",
        method: "PUT",
        body: JSON.stringify({
          value: { name: "Ada" },
          expected_version: 4,
        }),
      })
      .reply(200, {
        data: {
          key: "customer-1",
          collection: "customers",
          value: { name: "Ada" },
          version: 5,
        },
      });

    const payload = (await runJson([
      "app",
      "documents",
      "data",
      "put",
      "app_123",
      "customers",
      "customer-1",
      "--value",
      '{"name":"Ada"}',
      "--expected-version",
      "4",
      "--json",
    ])) as {
      ok: boolean;
      data: { data: { version: number } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.data.version).toBe(5);
  });

  it("completes only the exact durable automation claim", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/builder/apps/app_123/automation-runs/run_123/complete",
        method: "POST",
        body: JSON.stringify({
          cursor: 0,
          idempotency_key: "run_123:0",
          output: { rows: 3 },
        }),
      })
      .reply(200, {
        data: {
          id: "run_123",
          cursor: 1,
          status: "completed",
        },
      });

    const payload = (await runJson([
      "app",
      "documents",
      "automations",
      "complete",
      "app_123",
      "run_123",
      "--cursor",
      "0",
      "--idempotency-key",
      "run_123:0",
      "--output",
      '{"rows":3}',
      "--json",
    ])) as {
      ok: boolean;
      data: { data: { status: string } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.data.status).toBe("completed");
  });

  it("links a local directory to one exact deployment and workspace", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123",
        method: "GET",
      })
      .reply(200, {
        data: {
          id: "dep_123",
          name: "ClinicIQ",
          workspace_id: "ws_123",
          project_id: "proj_123",
        },
      });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-app-link-"));
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const payload = (await runJson([
        "app",
        "link",
        ".",
        "--app",
        "dep_123",
        "--environment",
        "production",
        "--json",
      ])) as {
        ok: boolean;
        data: { deployment_id: string; workspace_id: string };
      };
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, ".miosa.json"), "utf8"),
      ) as Record<string, unknown>;

      expect(payload.ok).toBe(true);
      expect(payload.data.deployment_id).toBe("dep_123");
      expect(payload.data.workspace_id).toBe("ws_123");
      expect(saved).toMatchObject({
        version: 2,
        deploymentId: "dep_123",
        workspaceId: "ws_123",
        environment: "production",
      });
    } finally {
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pulls configuration through the linked application workflow", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_123/env",
        method: "GET",
      })
      .reply(200, {
        data: [{ name: "DATABASE_URL", preview: "pos...db" }],
      });
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/opencomputers/secrets",
        method: "GET",
      })
      .reply(200, { data: [] });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-app-pull-"));
    fs.writeFileSync(
      path.join(dir, ".miosa.json"),
      JSON.stringify({
        version: 2,
        deploymentId: "dep_123",
        name: "ClinicIQ",
        environment: "preview",
      }),
    );
    try {
      const payload = (await runJson(["app", "pull", dir, "--json"])) as {
        ok: boolean;
        data: {
          deployment_id: string;
          environment: string;
          configuration: Record<string, string>;
        };
      };
      expect(payload).toMatchObject({
        ok: true,
        data: {
          deployment_id: "dep_123",
          environment: "preview",
          configuration: { DATABASE_URL: "pos...db" },
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a ready preview through one app command", async () => {
    sandboxMocks.deploySandbox.mockResolvedValue({
      sandbox_id: "sbx_123",
      port: 3000,
      preview_url: "https://3000-sbx.sandbox.miosa.ai",
      preview_ready: true,
    });

    const payload = (await runJson([
      "app",
      "preview",
      fixture("nextjs"),
      "--json",
    ])) as {
      ok: boolean;
      data: { sandbox_id: string; status: string; promotion_allowed: boolean };
    };
    expect(payload).toMatchObject({
      ok: true,
      data: {
        sandbox_id: "sbx_123",
        status: "ready",
        promotion_allowed: false,
      },
    });
    expect(sandboxMocks.deploySandbox).toHaveBeenCalledWith(
      path.resolve(fixture("nextjs")),
      expect.objectContaining({ wait: true, timeout: 600 }),
    );
  });

  it("reads durable server operation status", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/operations/op_123",
        method: "GET",
      })
      .reply(200, {
        data: {
          id: "op_123",
          status: "succeeded",
          current_step: "verified",
        },
      });

    const payload = (await runJson(["app", "status", "op_123", "--json"])) as {
      ok: boolean;
      data: { id: string; status: string };
    };

    expect(payload).toMatchObject({
      ok: true,
      data: { id: "op_123", status: "succeeded" },
    });
  });
});
