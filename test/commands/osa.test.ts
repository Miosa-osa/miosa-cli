import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { register } = await import("../../src/commands/osa.js");
const { initOsaProject } = await import("../../src/osa/scaffold.js");
const { discoverOsaProject } = await import("../../src/osa/discovery.js");
const { addSkill, searchSkills } = await import("../../src/osa/skills.js");
const { enableComputer } = await import("../../src/osa/computer.js");
const { buildOsaProject } = await import("../../src/osa/build.js");
const { runOsaEvals } = await import("../../src/osa/eval.js");
const { addConnection, addChannel } = await import("../../src/osa/integrations.js");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miosa-osa-test-"));
}

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

describe("miosa osa", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    delete process.env["MIOSA_API_KEY"];
    delete process.env["MIOSA_ENDPOINT"];
  });

  it("registers the osa command namespace", () => {
    const program = buildProgram();
    expect(program.commands.map((cmd) => cmd.name())).toContain("osa");
    const osa = program.commands.find((cmd) => cmd.name() === "osa");
    expect(osa?.commands.map((cmd) => cmd.name())).toEqual(
      expect.arrayContaining([
        "init",
        "info",
        "doctor",
        "build",
        "publish",
        "eval",
        "run",
        "dev",
        "deploy",
        "deployments",
        "projects",
        "skills",
        "computer",
        "connections",
        "channels",
      ]),
    );
  });

  it("scaffolds an OSA project without overwriting existing files", () => {
    const root = tmpDir();
    const result = initOsaProject({ target: root });

    expect(result.created).toContain("agent/AGENTS.md");
    expect(fs.existsSync(path.join(root, "agent", "agent.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agent", "skills", "getting-started.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agent", "channels", "slack.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "agent", "connections", "linear.ts"))).toBe(true);
    expect(fs.existsSync(path.join(root, "evals", "smoke.yml"))).toBe(true);

    const agentPath = path.join(root, "agent", "agent.ts");
    fs.writeFileSync(agentPath, "custom\n", "utf8");
    expect(() => initOsaProject({ target: root })).toThrow("already exist");
    expect(fs.readFileSync(agentPath, "utf8")).toBe("custom\n");
  });

  it("discovers an OSA project and writes manifest artifacts", () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    const discovery = discoverOsaProject({ target: root });

    expect(discovery.manifest.sourceRoot).toBe("agent");
    expect(discovery.manifest.agent.name).toBe(path.basename(root));
    expect(discovery.manifest.agent.config).toBe("agent/agent.ts");
    expect(discovery.manifest.runtimeProfile.model).toMatchObject({ primary: "default" });
    expect(discovery.manifest.runtimeProfile.harness).toMatchObject({
      engine: "auto",
      allowed: ["codex", "claude-code", "hermes", "osa"],
    });
    expect(discovery.manifest.runtimeProfile.runtime).toMatchObject({
      target: "miosa-cloud",
      durability: "checkpointed",
      streaming: true,
    });
    expect(discovery.manifest.runtimeProfile.sandbox).toMatchObject({
      backend: "auto",
      resources: { cpu: 2, memoryGb: 4 },
    });
    expect(discovery.manifest.skills.map((skill) => skill.name)).toContain("getting-started");
    expect(discovery.manifest.channels.map((channel) => channel.path)).toContain("agent/channels/slack.ts");
    expect(discovery.manifest.connections.map((connection) => connection.path)).toContain("agent/connections/linear.ts");
    expect(discovery.manifest.schedules.map((schedule) => schedule.path)).toContain("agent/schedules/daily-report.md");
    expect(discovery.manifest.subagents.map((subagent) => subagent.config)).toContain("agent/subagents/researcher/agent.ts");
    expect(discovery.manifest.sandbox.config).toBe("agent/sandbox/sandbox.ts");
    expect(discovery.manifest.evals.map((evalFile) => evalFile.name)).toContain("smoke");
    expect(fs.existsSync(path.join(root, ".miosa", "osa-manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".miosa", "osa-diagnostics.json"))).toBe(true);
  });

  it("keeps legacy osa layout compatibility", () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, "osa"), { recursive: true });
    fs.writeFileSync(path.join(root, "osa", "agent.yml"), "name: legacy-agent\n", "utf8");
    fs.writeFileSync(path.join(root, "osa", "instructions.md"), "Legacy instructions.\n", "utf8");

    const discovery = discoverOsaProject({ target: root, writeArtifacts: false });
    expect(discovery.manifest.sourceRoot).toBe("osa");
    expect(discovery.manifest.agent.name).toBe("legacy-agent");
    expect(discovery.manifest.context.instructions).toEqual(["osa/instructions.md"]);
    expect(discovery.manifest.diagnostics.errors).toBe(0);
  });

  it("reports missing root diagnostics", () => {
    const root = tmpDir();
    const discovery = discoverOsaProject({ target: root, writeArtifacts: false });

    expect(discovery.manifest.diagnostics.errors).toBeGreaterThan(0);
    expect(discovery.diagnostics.map((item) => item.code)).toContain("agent.root.missing");
  });

  it("searches and installs built-in skills", () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    const found = searchSkills("browser", { target: root });
    expect(found.map((skill) => skill.name)).toContain("browser-qa");

    const result = addSkill({ nameOrSource: "browser-qa", target: root });
    expect(result.installed.name).toBe("browser-qa");
    expect(fs.existsSync(path.join(root, "agent", "skills", "browser-qa", "SKILL.md"))).toBe(true);

    const discovery = discoverOsaProject({ target: root, writeArtifacts: false });
    expect(discovery.manifest.skills.map((skill) => skill.name)).toContain("browser-qa");
  });

  it("enables a computer profile", () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    const result = enableComputer({ target: root });
    expect(result.name).toBe("default");

    const discovery = discoverOsaProject({ target: root, writeArtifacts: false });
    expect(discovery.manifest.computers.find((computer) => computer.name === "default")?.enabled).toBe(true);
  });

  it("builds OSA artifacts and runs descriptor evals", () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    const build = buildOsaProject({ target: root });
    expect(build.errors).toBe(0);
    expect(fs.existsSync(path.join(root, ".miosa", "osa-build.json"))).toBe(true);

    const report = runOsaEvals({ target: root, strict: true });
    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.name)).toContain("smoke");
  });

  it("scaffolds connection and channel descriptors", () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    addConnection({
      kind: "mcp",
      name: "notion",
      target: root,
      url: "https://mcp.notion.example/sse",
      auth: "env",
    });
    addChannel({ kind: "slack", name: "support", target: root });

    const discovery = discoverOsaProject({ target: root, writeArtifacts: false });
    expect(discovery.manifest.connections.find((conn) => conn.name === "notion")?.hasAuth).toBe(true);
    expect(fs.existsSync(path.join(root, "agent", "channels", "support.ts"))).toBe(true);
  });

  it("creates dry-run plans for run, dev, and deploy commands", async () => {
    const root = tmpDir();
    initOsaProject({ target: root });

    const runPayload = (await runJson([
      "osa",
      "run",
      "check",
      "the",
      "repo",
      "--project",
      root,
      "--sandbox",
      "00000000-0000-0000-0000-000000000001",
      "--dry-run",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        plan: { kind: string; task: string; runtimeProfile: { harness: { engine: string } } };
        request: { sandbox_id: string; provider: string; runtime_profile: { harness: { engine: string } } };
      };
    };
    expect(runPayload.ok).toBe(true);
    expect(runPayload.data.plan.kind).toBe("run");
    expect(runPayload.data.plan.task).toBe("check the repo");
    expect(runPayload.data.plan.runtimeProfile.harness.engine).toBe("auto");
    expect(runPayload.data.request.provider).toBe("auto");
    expect(runPayload.data.request.runtime_profile.harness.engine).toBe("auto");
    expect(runPayload.data.request.sandbox_id).toBe("00000000-0000-0000-0000-000000000001");

    const devPayload = (await runJson(["osa", "dev", root, "--dry-run", "--json"])) as {
      ok: boolean;
      data: { kind: string };
    };
    expect(devPayload.ok).toBe(true);
    expect(devPayload.data.kind).toBe("dev");

    const deployPayload = (await runJson(["osa", "deploy", root, "--dry-run", "--json"])) as {
      ok: boolean;
      data: { kind: string; target: string };
    };
    expect(deployPayload.ok).toBe(true);
    expect(deployPayload.data.kind).toBe("deploy");
    expect(deployPayload.data.target).toBe("miosa-cloud");
  });

  it("uses agent.ts runtime profile for OSA run and lets flags override it", async () => {
    const root = tmpDir();
    initOsaProject({ target: root });
    fs.writeFileSync(
      path.join(root, "agent", "agent.ts"),
      `import { defineAgent } from "@miosa/osa";

export default defineAgent({
  description: "Repo engineering agent.",
  model: {
    primary: "openai/gpt-5",
    fallback: ["anthropic/claude-sonnet-4.6"],
  },
  harness: {
    engine: "codex",
  },
  runtime: {
    target: "miosa-cloud",
    durability: "checkpointed",
  },
  sandbox: {
    backend: "miosa-computer",
    resources: {
      cpu: 4,
      memoryGb: 8,
    },
  },
});
`,
      "utf8",
    );

    const payload = (await runJson([
      "osa",
      "run",
      "fix",
      "the",
      "bug",
      "--project",
      root,
      "--sandbox",
      "00000000-0000-0000-0000-000000000001",
      "--dry-run",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        request: {
          provider: string;
          model: string;
          runtime_profile: {
            model: { primary: string; fallback: string[] };
            harness: { engine: string };
            sandbox: { backend: string; resources: { cpu: number; memoryGb: number } };
          };
        };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.request.provider).toBe("codex");
    expect(payload.data.request.model).toBe("openai/gpt-5");
    expect(payload.data.request.runtime_profile.model.fallback).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(payload.data.request.runtime_profile.sandbox.resources).toEqual({ cpu: 4, memoryGb: 8 });

    const overridePayload = (await runJson([
      "osa",
      "run",
      "fix",
      "the",
      "bug",
      "--project",
      root,
      "--sandbox",
      "00000000-0000-0000-0000-000000000001",
      "--provider",
      "claude-code",
      "--model",
      "anthropic/claude-sonnet-4.6",
      "--dry-run",
      "--json",
    ])) as {
      data: {
        request: {
          provider: string;
          model: string;
          runtime_profile: { provider: string; harness: { engine: string }; model: string };
        };
      };
    };

    expect(overridePayload.data.request.provider).toBe("claude-code");
    expect(overridePayload.data.request.model).toBe("anthropic/claude-sonnet-4.6");
    expect(overridePayload.data.request.runtime_profile.harness.engine).toBe("claude-code");
  });

  it("publishes OSA project manifests to the backend", async () => {
    const root = tmpDir();
    initOsaProject({ target: root });
    process.env["MIOSA_API_KEY"] = "msk_u_test";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/osa-projects",
        method: "POST",
      })
      .reply(201, (opts) => {
        const body = JSON.parse(String(opts.body)) as {
          workspace_id: string;
          manifest: { agent: { name: string } };
          runtime_profile: { harness: { engine: string }; runtime: { target: string } };
          metadata: { osa_project: boolean };
        };
        expect(body.workspace_id).toBe("00000000-0000-0000-0000-000000000010");
        expect(body.manifest.agent.name).toBe(path.basename(root));
        expect(body.manifest.sourceRoot).toBe("agent");
        expect(body.runtime_profile.harness.engine).toBe("auto");
        expect(body.runtime_profile.runtime.target).toBe("miosa-cloud");
        expect(body.diagnostics.items).toEqual(expect.any(Array));
        expect(body.metadata.osa_project).toBe(true);
        return {
          data: {
            id: "osa_123",
            name: body.manifest.agent.name,
            workspace_id: body.workspace_id,
            status: "active",
          },
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = (await runJson([
      "osa",
      "publish",
      root,
      "--workspace",
      "00000000-0000-0000-0000-000000000010",
      "--json",
    ])) as { ok: boolean; data: { project: { id: string }; request: { manifest: { agent: { name: string } } } } };

    expect(payload.ok).toBe(true);
    expect(payload.data.project.id).toBe("osa_123");
    expect(payload.data.request.manifest.agent.name).toBe(path.basename(root));
  });

  it("deploys an OSA project by publishing then creating a deployment", async () => {
    const root = tmpDir();
    initOsaProject({ target: root });
    process.env["MIOSA_API_KEY"] = "msk_u_test";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/osa-projects",
        method: "POST",
      })
      .reply(201, {
        data: {
          id: "00000000-0000-0000-0000-0000000000aa",
          name: path.basename(root),
          workspace_id: "00000000-0000-0000-0000-000000000010",
          status: "active",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000aa/deployments",
        method: "POST",
      })
      .reply(201, (opts) => {
        const body = JSON.parse(String(opts.body)) as {
          deploy_target: string;
          deployment_plan: { kind: string; target: string; runtimeProfile: { runtime: { target: string } } };
          runtime_profile: { runtime: { target: string } };
          metadata: { osa_project: boolean };
        };
        expect(body.deploy_target).toBe("miosa-cloud");
        expect(body.deployment_plan.kind).toBe("deploy");
        expect(body.deployment_plan.target).toBe("miosa-cloud");
        expect(body.deployment_plan.runtimeProfile.runtime.target).toBe("miosa-cloud");
        expect(body.runtime_profile.runtime.target).toBe("miosa-cloud");
        expect(body.metadata.osa_project).toBe(true);
        return {
          data: {
            id: "00000000-0000-0000-0000-0000000000bb",
            osa_project_id: "00000000-0000-0000-0000-0000000000aa",
            target_kind: "miosa_cloud",
            status: "queued",
          },
        };
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = (await runJson([
      "osa",
      "deploy",
      root,
      "--workspace",
      "00000000-0000-0000-0000-000000000010",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        osaProjectId: string;
        deployment: { id: string; status: string };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.osaProjectId).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(payload.data.deployment.id).toBe("00000000-0000-0000-0000-0000000000bb");
    expect(payload.data.deployment.status).toBe("queued");
  });

  it("waits for an OSA deployment to reach terminal state", async () => {
    const root = tmpDir();
    initOsaProject({ target: root });
    process.env["MIOSA_API_KEY"] = "msk_u_test";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/osa-projects",
        method: "POST",
      })
      .reply(201, {
        data: {
          id: "00000000-0000-0000-0000-0000000000cc",
          name: "osa-agent",
          workspace_id: "00000000-0000-0000-0000-000000000010",
          status: "active",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000cc/deployments",
        method: "POST",
      })
      .reply(201, {
        data: {
          id: "00000000-0000-0000-0000-0000000000dd",
          osa_project_id: "00000000-0000-0000-0000-0000000000cc",
          status: "queued",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000cc/deployments/00000000-0000-0000-0000-0000000000dd",
        method: "GET",
      })
      .reply(200, {
        data: {
          id: "00000000-0000-0000-0000-0000000000dd",
          osa_project_id: "00000000-0000-0000-0000-0000000000cc",
          status: "deployed",
          runtime_url: "https://osa-runtime.example.test",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = (await runJson([
      "osa",
      "deploy",
      root,
      "--workspace",
      "00000000-0000-0000-0000-000000000010",
      "--wait",
      "--json",
    ])) as {
      ok: boolean;
      data: {
        deployment: { id: string; status: string; runtime_url: string };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.deployment.id).toBe("00000000-0000-0000-0000-0000000000dd");
    expect(payload.data.deployment.status).toBe("deployed");
    expect(payload.data.deployment.runtime_url).toBe("https://osa-runtime.example.test");
  });

  it("lists, shows, retries, and cancels OSA deployments", async () => {
    process.env["MIOSA_API_KEY"] = "msk_u_test";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000ee/deployments?status=failed",
        method: "GET",
      })
      .reply(200, {
        data: [
          {
            id: "00000000-0000-0000-0000-0000000000ff",
            osa_project_id: "00000000-0000-0000-0000-0000000000ee",
            status: "failed",
          },
        ],
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000ee/deployments/00000000-0000-0000-0000-0000000000ff",
        method: "GET",
      })
      .reply(200, {
        data: {
          id: "00000000-0000-0000-0000-0000000000ff",
          osa_project_id: "00000000-0000-0000-0000-0000000000ee",
          status: "failed",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000ee/deployments/00000000-0000-0000-0000-0000000000ff/retry",
        method: "POST",
      })
      .reply(200, {
        data: {
          id: "00000000-0000-0000-0000-0000000000ff",
          osa_project_id: "00000000-0000-0000-0000-0000000000ee",
          status: "queued",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: "/api/v1/osa-projects/00000000-0000-0000-0000-0000000000ee/deployments/00000000-0000-0000-0000-0000000000ff/cancel",
        method: "POST",
      })
      .reply(200, {
        data: {
          id: "00000000-0000-0000-0000-0000000000ff",
          osa_project_id: "00000000-0000-0000-0000-0000000000ee",
          status: "canceled",
        },
      }, {
        headers: { "content-type": "application/json" },
      });

    const listPayload = (await runJson([
      "osa",
      "deployments",
      "list",
      "00000000-0000-0000-0000-0000000000ee",
      "--status",
      "failed",
      "--json",
    ])) as { ok: boolean; data: Array<{ id: string; status: string }> };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.data[0]?.status).toBe("failed");

    const showPayload = (await runJson([
      "osa",
      "deployments",
      "show",
      "00000000-0000-0000-0000-0000000000ee",
      "00000000-0000-0000-0000-0000000000ff",
      "--json",
    ])) as { ok: boolean; data: { id: string; status: string } };
    expect(showPayload.ok).toBe(true);
    expect(showPayload.data.id).toBe("00000000-0000-0000-0000-0000000000ff");

    const retryPayload = (await runJson([
      "osa",
      "deployments",
      "retry",
      "00000000-0000-0000-0000-0000000000ee",
      "00000000-0000-0000-0000-0000000000ff",
      "--json",
    ])) as { ok: boolean; data: { status: string } };
    expect(retryPayload.ok).toBe(true);
    expect(retryPayload.data.status).toBe("queued");

    const cancelPayload = (await runJson([
      "osa",
      "deployments",
      "cancel",
      "00000000-0000-0000-0000-0000000000ee",
      "00000000-0000-0000-0000-0000000000ff",
      "--json",
    ])) as { ok: boolean; data: { status: string } };
    expect(cancelPayload.ok).toBe(true);
    expect(cancelPayload.data.status).toBe("canceled");
  });

  it("lists published OSA projects", async () => {
    process.env["MIOSA_API_KEY"] = "msk_u_test";

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/osa-projects?workspace_id=00000000-0000-0000-0000-000000000010",
        method: "GET",
      })
      .reply(200, {
        data: [
          {
            id: "osa_123",
            name: "osa-agent",
            workspace_id: "00000000-0000-0000-0000-000000000010",
            status: "active",
          },
        ],
      }, {
        headers: { "content-type": "application/json" },
      });

    const payload = (await runJson([
      "osa",
      "projects",
      "list",
      "--workspace",
      "00000000-0000-0000-0000-000000000010",
      "--json",
    ])) as { ok: boolean; data: Array<{ id: string }> };

    expect(payload.ok).toBe(true);
    expect(payload.data[0]?.id).toBe("osa_123");
  });

  it("supports command JSON output for init and info", async () => {
    const root = tmpDir();
    const initPayload = (await runJson(["osa", "init", root, "--json"])) as {
      ok: boolean;
      data: { projectRoot: string };
    };
    expect(initPayload.ok).toBe(true);
    expect(initPayload.data.projectRoot).toBe(root);

    const infoPayload = (await runJson(["osa", "info", root, "--json"])) as {
      ok: boolean;
      data: { manifest: { agent: { name: string } } };
    };
    expect(infoPayload.ok).toBe(true);
    expect(infoPayload.data.manifest.agent.name).toBe(path.basename(root));
  });
});
