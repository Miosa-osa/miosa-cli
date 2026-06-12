import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
  saveConfig: vi.fn(),
}));

const { register } = await import("../../src/commands/api-keys.js");

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

describe("miosa api-keys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("creates a scoped API key with external user, scopes, and expiry", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/api-keys/scoped",
        method: "POST",
        body: JSON.stringify({
          external_user_id: "cliniciq-user-1",
          scopes: ["sandboxes:read", "sandboxes:exec"],
          expires_at: "2026-12-31T00:00:00Z",
        }),
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            id: "key_123",
            token: "msk_l2_test",
            scopes: ["sandboxes:read", "sandboxes:exec"],
            expires_at: "2026-12-31T00:00:00Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "api-keys",
      "create-scoped",
      "--external-user-id",
      "cliniciq-user-1",
      "--scopes",
      "sandboxes:read, sandboxes:exec",
      "--expires-at",
      "2026-12-31T00:00:00Z",
      "--json",
    ]);

    expect(JSON.parse(logged.join(""))).toMatchObject({
      id: "key_123",
      token: "msk_l2_test",
      scopes: ["sandboxes:read", "sandboxes:exec"],
    });
  });
});
