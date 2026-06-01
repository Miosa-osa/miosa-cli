import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

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

const { register } = await import("../../src/commands/domains.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const deployment = {
  id: "dep-0000-0000-0000-000000000001",
  name: "Clinic Growth Platform",
  slug: "clinic-growth-platform",
};

const domain = {
  id: "dom-0000-0000-0000-000000000001",
  domain: "app.cliniciq.com",
  fqdn: "app.cliniciq.com",
  status: "pending",
  deployment_id: deployment.id,
  verification_target: "clinic-growth-platform.cliniciq.miosa.app",
  dns_records: [
    {
      type: "CNAME",
      name: "app",
      value: "clinic-growth-platform.cliniciq.miosa.app",
    },
  ],
};

describe("miosa domains app surface", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    delete process.env["MIOSA_JSON"];
    vi.restoreAllMocks();
  });

  it("adds a custom domain to an app by resolving deployment slug", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/clinic-growth-platform",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/domains",
        method: "POST",
        body: JSON.stringify({
          domain: "app.cliniciq.com",
          deployment_id: deployment.id,
        }),
      })
      .reply(201, JSON.stringify({ data: domain }), {
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
      "domains",
      "add",
      "app.cliniciq.com",
      "--app",
      "clinic-growth-platform",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      domain: "app.cliniciq.com",
      deployment_id: deployment.id,
    });
    expect(logged.join("\n")).not.toMatch(/MIOSA|Domain status|────/);
  });

  it("shows domain status as JSON when global JSON mode is set", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/domains/app.cliniciq.com",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: domain }), {
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
      "domains",
      "status",
      "app.cliniciq.com",
    ]);

    const raw = logged.join("\n");
    expect(JSON.parse(raw)).toMatchObject({
      domain: "app.cliniciq.com",
      deployment_id: deployment.id,
    });
    expect(raw).not.toMatch(/MIOSA|Domain status|────/);
  });

  it("shows custom domain status by hostname", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/domains/app.cliniciq.com",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: domain }), {
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
      "domains",
      "status",
      "app.cliniciq.com",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      domain: "app.cliniciq.com",
      deployment_id: deployment.id,
    });
  });

  it("assigns an existing custom domain to an app", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/clinic-growth-platform",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: deployment }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/domains/app.cliniciq.com/assign",
        method: "POST",
        body: JSON.stringify({ deployment_id: deployment.id }),
      })
      .reply(200, JSON.stringify({ data: domain }), {
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
      "domains",
      "assign",
      "app.cliniciq.com",
      "--app",
      "clinic-growth-platform",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      domain: "app.cliniciq.com",
      deployment_id: deployment.id,
    });
  });

  it("deletes a custom domain by hostname", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/domains/app.cliniciq.com",
        method: "DELETE",
      })
      .reply(
        200,
        JSON.stringify({
          id: domain.id,
          domain: "app.cliniciq.com",
          deleted: true,
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "domains",
      "delete",
      "app.cliniciq.com",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      domain: "app.cliniciq.com",
      deleted: true,
    });
  });
});
