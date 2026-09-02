import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const { register } = await import("../../src/commands/sandbox.js");

interface ConformanceFixture {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

const EXPECTED_CONTRACT_COMMIT = "774abcbc97380b599009759632691dc60d8e6b38";

function fixture(name: string): ConformanceFixture {
  const configuredRoot = process.env["MIOSA_API_CONTRACTS_ROOT"];
  const contractsRoot = configuredRoot
    ? resolve(configuredRoot)
    : resolve(process.cwd(), "test/fixtures/public-v1");
  if (!configuredRoot) {
    const pinnedCommit = readFileSync(
      resolve(contractsRoot, "CONTRACT_COMMIT"),
      "utf8",
    ).trim();
    if (pinnedCommit !== EXPECTED_CONTRACT_COMMIT) {
      throw new Error(`Unexpected vendored contract commit: ${pinnedCommit}`);
    }
  }
  const fixturePath = resolve(
    contractsRoot,
    "fixtures/conformance",
    `${name}.yaml`,
  );
  return parse(readFileSync(fixturePath, "utf8")) as ConformanceFixture;
}

function program(): Command {
  const command = new Command();
  command.exitOverride();
  register(command);
  return command;
}

describe("public sandbox contract conformance", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("sends the canonical minimal create fixture by default", async () => {
    const contract = fixture("create-default-small-request");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    let sentBody: Record<string, unknown> | undefined;
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: `/api/v1${contract.path}`,
        method: contract.method.toUpperCase(),
      })
      .reply(
        201,
        (opts: { body?: unknown }) => {
          sentBody = JSON.parse(String(opts.body ?? "{}")) as Record<
            string,
            unknown
          >;
          return JSON.stringify({ id: "sbx_fork", state: "provisioning" });
        },
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync(["node", "miosa", "sandbox", "create", "--json"]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
    // The create body carries at least the canonical contract fields (plus the
    // CLI's resolved defaults like size/timeout).
    expect(sentBody).toMatchObject(contract.body as Record<string, unknown>);
    // And an auto-generated Idempotency-Key makes create retry-safe.
  });

  it("uses the allowlisted pause, resume, extend, usage, and fork routes", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_1/pause", method: "POST" })
      .reply(200, JSON.stringify(fixture("pause-response").body), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_1/resume", method: "POST" })
      .reply(200, JSON.stringify({ id: "sbx_1", state: "running" }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_1/extend",
        method: "POST",
        body: JSON.stringify({ timeout_sec: 7200 }),
      })
      .reply(200, JSON.stringify({ id: "sbx_1", timeout_sec: 7200 }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({ path: "/api/v1/sandboxes/sbx_1/usage", method: "GET" })
      .reply(200, JSON.stringify(fixture("usage-response").body), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/sandboxes/sbx_1/fork",
        method: "POST",
        body: JSON.stringify({ timeout_sec: 7200 }),
      })
      .reply(201, JSON.stringify({ id: "sbx_2", state: "provisioning" }), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync(["node", "miosa", "sandbox", "pause", "sbx_1", "--json"]);
    await program().parseAsync(["node", "miosa", "sandbox", "resume", "sbx_1", "--json"]);
    await program().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "extend",
      "sbx_1",
      "--timeout",
      "2h",
      "--json",
    ]);
    await program().parseAsync(["node", "miosa", "sandbox", "usage", "sbx_1", "--json"]);
    await program().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "fork",
      "sbx_1",
      "--timeout",
      "2h",
      "--json",
    ]);

    expect(mock.pendingInterceptors()).toHaveLength(0);
  });

  it("requires force for the non-allowlisted permanent delete extension", () => {
    const sandbox = program().commands.find((command) => command.name() === "sandbox");
    const destroy = sandbox?.commands.find((command) => command.name() === "destroy");

    expect(destroy?.options.find((option) => option.long === "--force")?.mandatory).toBe(true);
  });
});
