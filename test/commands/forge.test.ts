import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: "osa",
    organization: "osa",
    workspace: null,
    default_host: null,
    region: null,
    output: "text",
  }),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

const { register } = await import("../../src/commands/forge.js");

const repository = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Platform",
  slug: "platform",
  default_branch: "main",
  visibility: "private",
  state: "active",
  clone_ready: true,
  clone_url: "https://forge.miosa.ai/osa/platform.git",
  project_ids: [],
  created_at: "2026-08-17T00:00:00Z",
  updated_at: "2026-08-17T00:00:00Z",
};

function program(): Command {
  const value = new Command();
  value.exitOverride();
  register(value);
  return value;
}

describe("miosa forge repo", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("lists, creates, shows, updates, and deletes with the canonical contract", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/forge/repositories", method: "GET" })
      .reply(200, { data: [repository] });
    pool
      .intercept({
        path: "/api/v1/forge/repositories",
        method: "POST",
        headers: {
          authorization: "Bearer msk_u_test",
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": /.+/,
          "x-miosa-tenant": "osa",
          "idempotency-key": "create-platform",
        },
        body: JSON.stringify({
          name: "Platform",
          default_branch: "main",
          visibility: "private",
        }),
      })
      .reply(201, { data: repository });
    pool
      .intercept({
        path: `/api/v1/forge/repositories/${repository.id}`,
        method: "GET",
      })
      .reply(200, { data: repository });
    pool
      .intercept({
        path: `/api/v1/forge/repositories/${repository.id}`,
        method: "PATCH",
        body: JSON.stringify({ visibility: "public" }),
      })
      .reply(200, {
        data: { ...repository, visibility: "public" },
      });
    pool
      .intercept({
        path: `/api/v1/forge/repositories/${repository.id}`,
        method: "DELETE",
      })
      .reply(204, "", {
        headers: {
          "x-forge-operation-id": "op-delete-platform",
          "idempotency-replayed": "false",
        },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await program().parseAsync(["node", "miosa", "forge", "repo", "list"]);
    expect(logged.join("\n")).toContain("VISIBILITY");
    expect(logged.join("\n")).toContain("platform");

    logged.length = 0;
    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "create",
      "Platform",
      "--idempotency-key",
      "create-platform",
      "--json",
    ]);
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      data: { id: repository.id, slug: "platform" },
    });

    logged.length = 0;
    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "show",
      repository.id,
      "--json",
    ]);
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      data: { clone_ready: true, clone_url: repository.clone_url },
    });

    logged.length = 0;
    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "update",
      repository.id,
      "--visibility",
      "public",
      "--json",
    ]);
    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      data: { visibility: "public" },
    });

    logged.length = 0;
    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "delete",
      repository.id,
      "--yes",
      "--json",
    ]);
    expect(JSON.parse(logged.join("\n"))).toEqual({
      data: {
        id: repository.id,
        status: "deleted",
        operation_id: "op-delete-platform",
        replayed: false,
      },
    });
  });

  it("fails closed when deletion is non-interactive and unconfirmed", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "delete",
      repository.id,
    ]);

    expect(process.exit).toHaveBeenCalled();
    expect(errors.join("\n")).toContain("Confirmation required");
  });

  it("rejects malformed repository responses instead of guessing", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/forge/repositories", method: "GET" })
      .reply(200, { data: [{ ...repository, clone_ready: false }] });
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await program().parseAsync([
      "node",
      "miosa",
      "forge",
      "repo",
      "list",
      "--json",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      ok: false,
      error: { code: "USER", retryable: false },
    });
  });

  it("matches the shared command fixture and omits unsupported commands", () => {
    const contract = JSON.parse(
      readFileSync(
        resolve("test/fixtures/forge-cli-command-contract.json"),
        "utf8",
      ),
    ) as {
      commands: Record<string, { flags: string[] }>;
      unsupported: string[];
    };
    const root = program();
    const forgeRepo = root.commands
      .find((command) => command.name() === "forge")
      ?.commands.find((command) => command.name() === "repo");
    expect(forgeRepo).toBeDefined();
    expect(forgeRepo?.commands.map((command) => command.name()).sort()).toEqual(
      Object.keys(contract.commands).sort(),
    );
    for (const [name, expected] of Object.entries(contract.commands)) {
      const command = forgeRepo?.commands.find((item) => item.name() === name);
      expect(command, `missing ${name}`).toBeDefined();
      for (const flag of expected.flags) {
        expect(
          command?.options.some((option) => option.long === flag),
          `${name} is missing ${flag}`,
        ).toBe(true);
      }
    }
    for (const unsupported of contract.unsupported) {
      expect(
        forgeRepo?.commands.some((item) => item.name() === unsupported),
      ).toBe(false);
    }
  });
});
