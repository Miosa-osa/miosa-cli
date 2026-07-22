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
}));

vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

const { register } = await import("../../src/commands/releases.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const app = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Clinic Growth Platform",
  slug: "clinic-growth-platform",
};

const release = {
  id: "22222222-2222-4222-8222-222222222222",
  deployment_id: app.id,
  deployment_version_id: "33333333-3333-4333-8333-333333333333",
  state: "ready",
  kind: "static",
  created_at: "2026-06-01T00:00:00Z",
};

describe("miosa releases", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("rolls back a release through the deployment rollback API", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/deployments", method: "GET" })
      .reply(200, JSON.stringify({ data: [app] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}/releases`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [release] }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}/rollback`,
        method: "POST",
        body: JSON.stringify({ release_id: release.id }),
      })
      .reply(200, JSON.stringify({ data: { ...app, active_version_id: release.deployment_version_id } }), {
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
      "releases",
      "rollback",
      release.id,
      "--yes",
    ]);

    expect(logged.join("\n")).toContain("Rollback queued");
    expect(logged.join("\n")).toContain(app.name);
  });

  it("uses the app-scoped release lookup and supports JSON output", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: `/api/v1/deployments/${app.slug}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: app }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}/releases/${release.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: release }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}/rollback`,
        method: "POST",
        body: JSON.stringify({ release_id: release.id }),
      })
      .reply(200, JSON.stringify({ data: { ...app, active_version_id: release.deployment_version_id } }), {
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
      "releases",
      "rollback",
      release.id,
      "--app",
      app.slug,
      "--yes",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      data: {
        id: app.id,
        active_version_id: release.deployment_version_id,
      },
    });
  });

  it("promotes the exact immutable release without translating to a version", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: app }), {
        headers: { "content-type": "application/json" },
      });

    pool
      .intercept({
        path: `/api/v1/deployments/${app.id}/releases/${release.id}/promote`,
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { ...app, active_version_id: release.deployment_version_id }, release_id: release.id }), {
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
      "releases",
      "promote-release",
      app.id,
      release.id,
      "--yes",
    ]);

    expect(logged.join("\n")).toContain(`Release ${release.id.slice(0, 8)} promoted`);
  });
});
