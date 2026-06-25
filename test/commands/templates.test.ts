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

const { register } = await import("../../src/commands/templates.js");

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

const catalog = {
  templates: [
    {
      id: "miosa-sandbox",
      name: "MIOSA Sandbox",
      product: "sandbox",
      default_size: "small",
      sdk_name: "client.sandboxes",
      cli_name: "miosa sandbox",
      installed_tools: ["node", "python", "git"],
      sizes: [{ size: "small", state: "fast_ready", ready_nodes: 10, checked_nodes: 10 }],
    },
    {
      id: "miosa-desktop",
      name: "MIOSA Desktop Computer",
      product: "computer",
      default_size: "small",
      sdk_name: "client.computers",
      cli_name: "miosa computers",
      sizes: [{ size: "small", state: "fast_ready", ready_nodes: 6, checked_nodes: 10 }],
    },
  ],
};

describe("miosa templates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("lists canonical product templates", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync(["node", "miosa", "templates", "list"]);

    const output = logged.join("\n");
    expect(output).toContain("miosa-sandbox");
    expect(output).toContain("sandbox");
    expect(output).toContain("miosa-desktop");
    expect(output).toContain("computer");
  });

  it("filters product templates by product in json mode", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "templates",
      "list",
      "--product",
      "computer",
      "--json",
    ]);

    const templates = JSON.parse(logged.join("")) as Array<{ id: string; product: string }>;
    expect(templates).toEqual([{ ...catalog.templates[1] }]);
  });

  it("shows template readiness", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "templates",
      "readiness",
      "miosa-desktop",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("small");
    expect(output).toContain("fast_ready");
    expect(output).toContain("6/10");
  });
});
