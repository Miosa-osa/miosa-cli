import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
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

describe("miosa templates create", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  function writeDockerfile(content: string): string {
    const dir = mkdtempSync(join(os.tmpdir(), "miosa-tmpl-"));
    const file = join(dir, "Dockerfile");
    writeFileSync(file, content, "utf8");
    return file;
  }

  it("forwards resource flags as integers and emits exactly one JSON payload", async () => {
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // 4 vCPU / 8 GB is the published `medium` pair; memory 8gb → 8192 MiB,
    // disk 30gb → 30720 MiB, cpu as a raw integer.
    const expectedBody = JSON.stringify({
      name: "cpu-test",
      dockerfile: "FROM alpine\n",
      cpu_count: 4,
      memory_mb: 8192,
      disk_size_mb: 30720,
      size: "medium",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandbox-templates",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "tmpl_1", name: "cpu-test", state: "building" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "cpu-test",
      "--dockerfile",
      dockerfile,
      "--cpu",
      "4",
      "--memory",
      "8gb",
      "--disk",
      "30gb",
      "--size",
      "medium",
      "--json",
    ]);

    // An empty pending list proves the exact request body matched.
    expect(mock.pendingInterceptors()).toEqual([]);
    // stdout must be a single, clean JSON document - no spinner or status text.
    expect(JSON.parse(output.join("\n"))).toEqual({
      id: "tmpl_1",
      name: "cpu-test",
      state: "building",
    });
  });

  it("omits resource fields entirely when no flags are given", async () => {
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // No cpu_count / memory_mb / disk_size_mb / size: let the server default.
    const expectedBody = JSON.stringify({
      name: "default-shape",
      dockerfile: "FROM alpine\n",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandbox-templates",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "tmpl_2", name: "default-shape", state: "building" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "default-shape",
      "--dockerfile",
      dockerfile,
      "--json",
    ]);

    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("passes a custom off-tier cpu/memory pair through unchanged", async () => {
    // MIOSA bills for the exact resources consumed -- 4 vCPU / 4096 MiB is
    // not a published pair (medium is 4 vCPU / 8192 MiB), but it is a valid
    // custom shape and must reach the server as-is: no rejection, no
    // snapping to the nearest tier, no synthesized `size`.
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      name: "custom-shape",
      dockerfile: "FROM alpine\n",
      cpu_count: 4,
      memory_mb: 4096,
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandbox-templates",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "tmpl_custom", name: "custom-shape", state: "building" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "custom-shape",
      "--dockerfile",
      dockerfile,
      "--cpu",
      "4",
      "--memory",
      "4gb",
      "--json",
    ]);

    // An empty pending list proves the exact request body matched -- no
    // `size` field was synthesized and the raw pair was not rejected.
    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("passes a fully custom cpu/memory/disk triple through unchanged", async () => {
    // HackerAI's requested shape: 4 vCPU / 4096 MiB / a custom disk floor.
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const expectedBody = JSON.stringify({
      name: "custom-triple",
      dockerfile: "FROM alpine\n",
      cpu_count: 4,
      memory_mb: 4096,
      disk_size_mb: 30720,
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandbox-templates",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "tmpl_triple", name: "custom-triple", state: "building" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "custom-triple",
      "--dockerfile",
      dockerfile,
      "--cpu",
      "4",
      "--memory",
      "4096",
      "--disk",
      "30720",
      "--json",
    ]);

    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("still resolves a raw pair that matches a published tier to a named size", async () => {
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    // 4 vCPU / 8192 MiB is exactly `medium` -- still fine, and the wire may
    // still carry the resolved `size` alongside the raw pair.
    const expectedBody = JSON.stringify({
      name: "on-tier",
      dockerfile: "FROM alpine\n",
      cpu_count: 4,
      memory_mb: 8192,
      size: "medium",
    });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandbox-templates",
        method: "POST",
        body: expectedBody,
      })
      .reply(
        200,
        JSON.stringify({
          data: { id: "tmpl_ontier", name: "on-tier", state: "building" },
        }),
        { headers: { "content-type": "application/json" } },
      );

    vi.spyOn(console, "log").mockImplementation(() => {});

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "on-tier",
      "--dockerfile",
      dockerfile,
      "--cpu",
      "4",
      "--memory",
      "8gb",
      "--json",
    ]);

    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("rejects an explicit --size that conflicts with an explicit raw pair", async () => {
    const dockerfile = writeDockerfile("FROM alpine\n");
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    // No interceptor is registered on purpose: the conflict must be caught
    // locally, before any network call.

    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });

    // --size small (2 vCPU / 4096 MiB) disagrees with the explicit 4 vCPU.
    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "conflict",
      "--dockerfile",
      dockerfile,
      "--cpu",
      "4",
      "--size",
      "small",
      "--json",
    ]);

    const payload = JSON.parse(output.join("\n")) as {
      ok: boolean;
      error: { message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.message).toContain("small");
  });
});
