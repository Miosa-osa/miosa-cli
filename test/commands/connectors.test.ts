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
          type: "api-key",
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
});
