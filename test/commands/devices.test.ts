import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const { register } = await import("../../src/commands/devices.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa devices", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env["MIOSA_JSON"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("prints a catalog of MIOSA device kinds for agents", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "devices", "catalog", "--json"]);

    const output = JSON.parse(logged.join("")) as {
      devices: Array<{ kind: string; primary_commands: string[] }>;
      routing: Record<string, string>;
    };

    expect(output.devices.map((device) => device.kind)).toEqual(
      expect.arrayContaining([
        "sandbox_worker",
        "computer",
        "local_device",
        "docker_deploy_host",
      ]),
    );
    expect(output.routing["build_code"]).toContain("sandbox");
    expect(
      output.devices
        .find((device) => device.kind === "sandbox_worker")
        ?.primary_commands.some((command) =>
          command.startsWith("miosa sandbox run-agent"),
        ),
    ).toBe(true);
  });

  it("normalizes sandboxes and computers into one device list", async () => {
    const oldJsonMode = process.env["MIOSA_JSON"];
    process.env["MIOSA_JSON"] = "1";
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/sandboxes", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "sbx_123",
              name: "builder",
              template_id: "nextjs",
              state: "running",
              ready: true,
              persistent: true,
              preview_url: "https://3000-sbx_123.sandbox.miosa.app",
              timeout_remaining_ms: 3_600_000,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "cmp_123",
              name: "desktop",
              status: "running",
              region: "us-nyc",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "devices", "list", "--json"]);

    process.env["MIOSA_JSON"] = oldJsonMode;

    const output = JSON.parse(logged.join("")) as {
      devices: Array<{ id: string; kind: string; state: string }>;
      errors: unknown[];
    };

    expect(output.errors).toEqual([]);
    expect(output.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "sbx_123",
          kind: "sandbox_worker",
          state: "running",
        }),
        expect.objectContaining({
          id: "cmp_123",
          kind: "computer",
          state: "running",
        }),
      ]),
    );
  });

  it("keeps partial device inventory usable when one resource endpoint fails", async () => {
    process.env["MIOSA_JSON"] = "1";
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/sandboxes", method: "GET" })
      .reply(
        200,
        JSON.stringify({ data: [{ id: "sbx_123", state: "running" }] }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/computers", method: "GET" })
      .reply(502, "bad gateway", {
        headers: { "content-type": "text/plain" },
      });

    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "devices", "list", "--json"]);

    const output = JSON.parse(logged.join("")) as {
      devices: Array<{ id: string; kind: string }>;
      errors: Array<{ source: string; retryable: boolean }>;
    };

    expect(output.devices).toEqual([
      expect.objectContaining({ id: "sbx_123", kind: "sandbox_worker" }),
    ]);
    expect(output.errors).toEqual([
      expect.objectContaining({ source: "computers", retryable: true }),
    ]);
  });
});
