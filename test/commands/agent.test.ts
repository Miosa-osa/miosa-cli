import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

const { register } = await import("../../src/commands/agent.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const computer = {
  id: "comp-0000-0000-0000-000000000001",
  name: "my-mac",
  status: "running",
};

const session = {
  id: "sess-0000-0000-0000-000000000001",
  computer_id: computer.id,
  status: "running",
  goal: "run the tests",
};

describe("miosa agent", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("starts a computer agent session with the Orgo-style shortcut", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(200, JSON.stringify({ data: [computer] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/cua/sessions`,
        method: "POST",
        body: JSON.stringify({ goal: "run the tests" }),
      })
      .reply(201, JSON.stringify({ data: session }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "agent", "my-mac", "run", "the", "tests"]);

    expect(logged.join("\n")).toContain(session.id);
    expect(logged.join("\n")).toContain("Resume:");
  });

  it("honors MIOSA_JSON for agent output", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(200, JSON.stringify({ data: [computer] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/cua/sessions`,
        method: "POST",
        body: JSON.stringify({ goal: "run the tests" }),
      })
      .reply(201, JSON.stringify({ data: session }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "agent", "my-mac", "run", "the", "tests"]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: session.id,
      goal: "run the tests",
    });
  });

  it("resumes a session from the shortcut command", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(200, JSON.stringify({ data: [computer] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/cua/sessions/${session.id}/resume`,
        method: "POST",
        body: JSON.stringify({}),
      })
      .reply(200, JSON.stringify({ data: { ...session, status: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/computers/${computer.id}/cua/sessions/${session.id}/task`,
        method: "POST",
        body: JSON.stringify({ instruction: "continue the fix" }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "agent",
      "my-mac",
      "--resume",
      session.id,
      "continue",
      "the",
      "fix",
    ]);

    expect(logged.join("\n")).toContain(`Session ${session.id} resumed.`);
    expect(logged.join("\n")).toContain("Task submitted");
  });

  it("runs one prompt against a sandbox through Agent Runs", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs",
        method: "POST",
        body: JSON.stringify({
          target_kind: "sandbox",
          target_id: "sbx_123",
          prompt: "build the page",
          provider: "codex",
          env: { FEATURE_FLAG: "on" },
          agent_runtime_profile_id: "prof_123",
          external_workspace_id: "clinic-iq",
          external_user_id: "founder-1",
          external_project_id: "landing-page",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            provider: "codex",
            status: "succeeded",
          },
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
      "agent",
      "run",
      "build",
      "the",
      "page",
      "--sandbox",
      "sbx_123",
      "--provider",
      "codex",
      "--env",
      "FEATURE_FLAG=on",
      "--agent-profile",
      "prof_123",
      "--external-workspace",
      "clinic-iq",
      "--external-user",
      "founder-1",
      "--external-project",
      "landing-page",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "run_123",
      target_kind: "sandbox",
      provider: "codex",
    });
  });

  it("can wait for a sandbox Agent Run to finish", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs",
        method: "POST",
        body: JSON.stringify({
          target_kind: "sandbox",
          target_id: "sbx_123",
          prompt: "build the page",
          provider: "codex",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            provider: "codex",
            status: "running",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool
      .intercept({
        path: "/api/v1/agent-runs/run_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            provider: "codex",
            status: "succeeded",
            output: "done",
          },
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
      "agent",
      "run",
      "build",
      "the",
      "page",
      "--sandbox",
      "sbx_123",
      "--provider",
      "codex",
      "--wait",
      "--wait-timeout",
      "5",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "run_123",
      target_kind: "sandbox",
      provider: "codex",
      status: "succeeded",
      output: "done",
    });
  });

  it("passes execution packet, output contract, approval policy, and capabilities to Agent Runs", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-agent-contract-"));
    const packetFile = path.join(tmpDir, "packet.json");
    fs.writeFileSync(
      packetFile,
      JSON.stringify({
        goal: "build ClinicIQ landing page",
        context: { customer: "ClinicIQ" },
      }),
    );

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/agent-runs",
        method: "POST",
        body: JSON.stringify({
          target_kind: "sandbox",
          target_id: "sbx_123",
          prompt: "build the page",
          provider: "claude-code",
          execution_packet: {
            goal: "build ClinicIQ landing page",
            context: { customer: "ClinicIQ" },
          },
          output_contract: {
            artifacts: [{ path: "/workspace/report.html", kind: "html" }],
            preview_port: 3000,
          },
          approval_policy: { publish: "manual" },
          capability_requirements: ["filesystem", "shell"],
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "run_123",
            target_kind: "sandbox",
            target_id: "sbx_123",
            provider: "claude-code",
            status: "succeeded",
          },
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
      "agent",
      "run",
      "build",
      "the",
      "page",
      "--sandbox",
      "sbx_123",
      "--execution-packet-file",
      packetFile,
      "--output-contract",
      '{"artifacts":[{"path":"/workspace/report.html","kind":"html"}],"preview_port":3000}',
      "--approval-policy",
      '{"publish":"manual"}',
      "--capability",
      "filesystem",
      "--capability",
      "shell",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "run_123",
      target_kind: "sandbox",
    });
  });

  it("runs one prompt against an OpenComputers host", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/opencomputers/hosts/host_abc/agent/dispatch",
        method: "POST",
        body: JSON.stringify({
          task: "audit the browser",
          model: "claude-code",
          agent_runtime_profile_id: "prof_123",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          id: "sess_123",
          session_id: "sess_123",
          host_id: "host_abc",
          status: "running",
          agent_runtime_profile_id: "prof_123",
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
      "agent",
      "run",
      "audit",
      "the",
      "browser",
      "--host",
      "host_abc",
      "--model",
      "claude-code",
      "--agent-profile",
      "prof_123",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "sess_123",
      host_id: "host_abc",
      agent_runtime_profile_id: "prof_123",
    });
  });
});
