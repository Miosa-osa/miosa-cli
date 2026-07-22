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

const { register } = await import("../../src/commands/templates.js");

const catalog = parse(
  readFileSync(
    resolve(
      process.cwd(),
      "test/fixtures/public-v1/fixtures/conformance/templates-response.yaml",
    ),
    "utf8",
  ),
) as { body: Record<string, unknown> };

function program(): Command {
  const command = new Command();
  command.exitOverride();
  register(command);
  return command;
}

describe("miosa templates product catalog", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("prints the canonical default shape", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/templates", method: "GET" })
      .reply(200, JSON.stringify(catalog.body), {
        headers: { "content-type": "application/json" },
      });
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await program().parseAsync(["node", "miosa", "templates", "catalog"]);

    expect(output.join("\n")).toContain("small");
  });

  it("prints exact readiness contracts as JSON", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/templates", method: "GET" })
      .reply(200, JSON.stringify(catalog.body), {
        headers: { "content-type": "application/json" },
      });
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "readiness",
      "miosa-sandbox",
      "--json",
    ]);

    expect(JSON.parse(output.join("\n"))).toEqual([
      expect.objectContaining({
        size: "xs",
        resource_contract: expect.objectContaining({
          contract_id: "sandbox/xs@v1",
        }),
      }),
      expect.objectContaining({
        size: "small",
        resource_contract: expect.objectContaining({
          contract_id: "sandbox/small@v1",
          vcpus: 2,
          memory_mb: 4096,
          disk_size_mb: 10240,
        }),
      }),
    ]);
  });
});
