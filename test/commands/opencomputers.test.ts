import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    succeed: vi.fn(),
    warn: vi.fn(),
    fail: vi.fn(),
  }),
}));

const { register } = await import("../../src/commands/opencomputers.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const createdHost = {
  id: "host-0000-0000-0000-000000000001",
  name: "studio",
  state: "pending",
  platform: "linux",
  os: null,
  arch: null,
  hostname: null,
  last_heartbeat: null,
  host_key: "oc_host_secret",
  install_command:
    "curl -fsSL https://api.miosa.ai/install-host.sh | bash -s -- --key oc_host_secret --region us-central",
  tenant_id: "tenant-0000-0000-0000-000000000001",
  inserted_at: "2026-07-20T00:00:00Z",
  updated_at: "2026-07-20T00:00:00Z",
};

describe("miosa opencomputers", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a host through the logged-in MIOSA account without leaking its install key in JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/opencomputers/hosts",
        method: "POST",
        body: JSON.stringify({ name: "studio", platform: "linux" }),
      })
      .reply(201, JSON.stringify({ data: createdHost }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "opencomputers",
      "connect",
      "studio",
      "--platform",
      "linux",
      "--no-wait",
      "--json",
    ]);

    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain('"id": "host-0000-0000-0000-000000000001"');
    expect(output).not.toContain("oc_host_secret");
    expect(output).not.toContain("install_command");
  });

  it("requires an explicit platform for non-interactive setup", async () => {
    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node",
        "miosa",
        "opencomputers",
        "connect",
        "studio",
        "--no-wait",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Provide --platform when running non-interactively",
    );
  });
});
