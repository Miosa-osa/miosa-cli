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

const { register } = await import("../../src/commands/connectors.js");

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

describe("miosa connectors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("creates an API-key connector without printing the raw provider key", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/connectors",
        method: "POST",
        body: JSON.stringify({
          provider: "anthropic",
          type: "api_key",
          uid: "anthropic/workspace-claude",
          scope: "tenant",
          credential: {
            field: "api_key",
            value: "sk-ant-secret",
          },
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "conn_123",
            uid: "anthropic/workspace-claude",
            provider: "anthropic",
            type: "api-key",
            status: "active",
            preview: "sk-ant-...cret",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "connectors",
      "create",
      "anthropic",
      "--name",
      "workspace-claude",
      "--value",
      "sk-ant-secret",
      "--json",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("anthropic/workspace-claude");
    expect(output).not.toContain("sk-ant-secret");
  });

  it("requests a user-subject runtime token with provider scopes", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/token/github%2Facme",
        method: "POST",
        body: JSON.stringify({
          subject: { type: "user", id: "user_123" },
          installation_id: "inst_org_123",
          project_id: "prj_123",
          environment: "production",
          resource_type: "sandbox",
          resource_id: "sbx_123",
          scopes: ["repo:read"],
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            token: "gho_short",
            expires_at: 1780000000000,
            connector: { uid: "github/acme", type: "github" },
            installation_id: "inst_org_123",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "connectors",
      "token",
      "github/acme",
      "--subject",
      "user:user_123",
      "--installation-id",
      "inst_org_123",
      "--project",
      "prj_123",
      "--environment",
      "production",
      "--resource-type",
      "sandbox",
      "--resource-id",
      "sbx_123",
      "--scope",
      "repo:read",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      token: "gho_short",
      connector: { uid: "github/acme" },
      installation_id: "inst_org_123",
    });
  });

  it("lists installations and manages project links", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/installations?workspace_id=ws_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ id: "inst_row", installation_id: "default" }],
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/project-links",
        method: "POST",
        body: JSON.stringify({
          connector: "github/workspace",
          installation_id: "inst_row",
          project_id: "prj_123",
          environment: "production",
          allowed_scopes: ["repo:read"],
          mode: "token_api",
          effect: "allow",
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "link_123", allowed_scopes: ["repo:read"] } }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/project-links?project_id=prj_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [{ id: "link_123" }] }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/project-links/link_123",
        method: "DELETE",
      })
      .reply(200, JSON.stringify({ data: { id: "link_123" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "installations",
      "--workspace",
      "ws_123",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "project-links",
      "create",
      "github/workspace",
      "--installation-id",
      "inst_row",
      "--project",
      "prj_123",
      "--environment",
      "production",
      "--scope",
      "repo:read",
      "--mode",
      "token-api",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "project-links",
      "list",
      "--project",
      "prj_123",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "project-links",
      "delete",
      "link_123",
      "--json",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("inst_row");
    expect(output).toContain("link_123");
    expect(output).toContain("repo:read");
  });

  it("manages inbound connector triggers", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/triggers",
        method: "POST",
        body: JSON.stringify({
          connector: "slack/workspace",
          project_id: "prj_123",
          environment: "production",
          destination_path: "/api/connect/slack",
          event_types: ["app_mention"],
          status: "active",
          provider_adapter: "slack",
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "trg_123", event_types: ["app_mention"] } }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/triggers?project_id=prj_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [{ id: "trg_123" }] }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/triggers/trg_123",
        method: "DELETE",
      })
      .reply(200, JSON.stringify({ data: { id: "trg_123" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/trigger-deliveries?trigger_id=trg_123&state=delivered&event_type=app_mention",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ id: "del_123", trigger_id: "trg_123", state: "delivered" }],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "triggers",
      "create",
      "slack/workspace",
      "--project",
      "prj_123",
      "--environment",
      "production",
      "--destination-path",
      "/api/connect/slack",
      "--event-type",
      "app_mention",
      "--provider-adapter",
      "slack",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "triggers",
      "list",
      "--project",
      "prj_123",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "triggers",
      "deliveries",
      "--trigger",
      "trg_123",
      "--state",
      "delivered",
      "--event-type",
      "app_mention",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "triggers",
      "delete",
      "trg_123",
      "--json",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("trg_123");
    expect(output).toContain("del_123");
    expect(output).toContain("app_mention");
  });

  it("lists and starts OAuth provider authorization", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/oauth/providers",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({ data: [{ provider: "github", scopes: ["repo"] }] }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/oauth/start",
        method: "POST",
        body: JSON.stringify({
          provider: "github",
          expose_as_env: true,
          owner_user_id: "user_123",
          external_user_id: "clinic-user",
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            authorize_url: "https://github.com/login/oauth/authorize",
            state: "st_123",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "oauth",
      "providers",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "oauth",
      "start",
      "github",
      "--expose-as-env",
      "--owner-user-id",
      "user_123",
      "--external-user-id",
      "clinic-user",
      "--json",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("github");
    expect(output).toContain("st_123");
  });

  it("manages inherited connector defaults", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/defaults",
        method: "POST",
        body: JSON.stringify({
          connector: "anthropic/workspace",
          project_id: "prj_123",
          environment: "development",
          default_scope: "project",
          target: "agent",
          allowed_scopes: ["messages:create"],
          mode: "brokered_env",
          effect: "allow",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: { id: "def_123", default_scope: "project", target: "agent" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/defaults?project_id=prj_123&default_scope=project&target=agent",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [{ id: "def_123", default_scope: "project", target: "agent" }],
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/defaults/applicable?workspace_id=ws_123&project_id=prj_123&environment=development&target=agent&resource_type=sandbox&resource_id=sbx_123",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "def_123",
              default_scope: "project",
              target: "agent",
              applicability: { matched_scope: "project" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/defaults/materialize",
        method: "POST",
        body: JSON.stringify({
          workspace_id: "ws_123",
          project_id: "prj_123",
          environment: "development",
          target: "agent",
          resource_type: "sandbox",
          resource_id: "sbx_123",
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            applied: 1,
            results: [{ status: "applied", default_id: "def_123" }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/connect/defaults/def_123",
        method: "DELETE",
      })
      .reply(200, JSON.stringify({ data: { id: "def_123" } }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "defaults",
      "create",
      "anthropic/workspace",
      "--project",
      "prj_123",
      "--default-scope",
      "project",
      "--target",
      "agent",
      "--scope",
      "messages:create",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "defaults",
      "materialize",
      "--workspace",
      "ws_123",
      "--project",
      "prj_123",
      "--environment",
      "development",
      "--target",
      "agent",
      "--resource-type",
      "sandbox",
      "--resource-id",
      "sbx_123",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "defaults",
      "applicable",
      "--workspace",
      "ws_123",
      "--project",
      "prj_123",
      "--environment",
      "development",
      "--target",
      "agent",
      "--resource-type",
      "sandbox",
      "--resource-id",
      "sbx_123",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "defaults",
      "list",
      "--project",
      "prj_123",
      "--default-scope",
      "project",
      "--target",
      "agent",
      "--json",
    ]);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "connectors",
      "defaults",
      "delete",
      "def_123",
      "--json",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("def_123");
    expect(output).toContain("project");
    expect(output).toContain("agent");
  });
});
