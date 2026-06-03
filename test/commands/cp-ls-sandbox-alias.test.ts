import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const cpCommand = await import("../../src/commands/cp.js");
const lsCommand = await import("../../src/commands/ls.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  cpCommand.register(program);
  lsCommand.register(program);
  return program;
}

describe("top-level sandbox cp/ls aliases", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads a local file to sandbox-id:/path with top-level miosa cp", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-cp-test-"));
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "hello");

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_123", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files",
        method: "POST",
        body: JSON.stringify({
          path: "/workspace/file.txt",
          content: Buffer.from("hello").toString("base64"),
        }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "cp",
      file,
      "sbx_123:/workspace/file.txt",
    ]);

    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("prints valid JSON only for top-level sandbox cp --json", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-cp-json-test-"));
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "hello");

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_123", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files",
        method: "POST",
        body: JSON.stringify({
          path: "/workspace/file.txt",
          content: Buffer.from("hello").toString("base64"),
        }),
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
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
      "cp",
      file,
      "sbx_123:/workspace/file.txt",
      "--json",
    ]);

    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({
      ok: true,
      data: {
        sandbox_id: "sbx_123",
        target: "/workspace/file.txt",
        type: "file",
      },
    });
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });

  it("lists sandbox-id:/path with top-level miosa ls", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123",
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: { id: "sbx_123", state: "running" } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
      })
      .reply(
        200,
        JSON.stringify({
          data: {
            stdout:
              "package.json\tf\t42\t-rw-r--r--\t1780500000\n",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "ls",
      "sbx_123:/workspace",
    ]);

    expect(logged.join("\n")).toContain("package.json");
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});
