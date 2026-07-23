import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: "cliniciq",
    workspace: null,
  }),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

const { register } = await import("../../src/commands/teams.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

describe("miosa teams organization membership commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists members through the live tenant-members endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/tenant/members", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          data: [
            {
              id: "member-123456789",
              user_id: "user-123456789",
              email: "admin@cliniciq.com",
              role: "admin",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync(["node", "miosa", "teams", "list"]);

    expect(logged.join("\n")).toContain("admin@cliniciq.com");
  });

  it("invites through the live tenant-members endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/tenant/members",
        method: "POST",
        body: JSON.stringify({ email: "operator@cliniciq.com", role: "admin" }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            invite_id: "invite-123",
            email: "operator@cliniciq.com",
            role: "admin",
            status: "pending",
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
      "teams",
      "invite",
      "operator@cliniciq.com",
      "--role",
      "admin",
    ]);

    expect(logged.join("\n")).toContain("invite-123");
  });

  it("updates roles through the live tenant-members endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/tenant/members/member-123/role",
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      })
      .reply(200, JSON.stringify({ data: { id: "member-123", role: "admin" } }), {
        headers: { "content-type": "application/json" },
      });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "teams",
      "role",
      "member-123",
      "admin",
    ]);
  });

  it("removes a member through the live tenant-members endpoint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/tenant/members/member-123",
        method: "DELETE",
      })
      .reply(204);

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "teams",
      "remove",
      "member-123",
      "--force",
    ]);
  });
});
