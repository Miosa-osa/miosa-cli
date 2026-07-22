import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT_USER_ERROR } from "../../src/types.js";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
}));

const { register } = await import("../../src/commands/sandbox.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function makeLocalDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-sync-guard-"));
  fs.writeFileSync(path.join(dir, "file.txt"), "hello");
  return dir;
}

describe("sandbox sync/cp --delete guard", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    vi.restoreAllMocks();
  });

  it("refuses sync --delete against a protected root even with --force", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "sync",
      makeLocalDir(),
      "/var",
      "--sandbox",
      "sbx_123",
      "--delete",
      "--force",
    ]);

    expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    expect(errors.join("\n")).toMatch(/Refusing --delete/);
  });

  it("refuses cp --delete against a protected root spelled with dot segments", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "cp",
      makeLocalDir(),
      "sbx_123:/var/lib/../lib/",
      "--delete",
      "--force",
    ]);

    expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    expect(errors.join("\n")).toMatch(/Refusing --delete/);
  });

  it("hard-errors when --delete runs non-interactively without --force", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "sync",
      makeLocalDir(),
      "/workspace/app",
      "--sandbox",
      "sbx_123",
      "--delete",
    ]);

    expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    const output = errors.join("\n");
    expect(output).toMatch(/sbx_123/);
    expect(output).toMatch(/\/workspace\/app/);
    expect(output).toMatch(/--force/);
  });

  it("wipes the normalized remote dir when --force is passed on a safe path", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    let execCommand = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
        body: (raw: string) => {
          execCommand = String(
            (JSON.parse(raw) as { command?: string }).command ?? "",
          );
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0 } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "sync",
      makeLocalDir(),
      "/workspace//app/",
      "--sandbox",
      "sbx_123",
      "--delete",
      "--force",
    ]);

    expect(process.exit).not.toHaveBeenCalled();
    expect(execCommand).toContain(
      "rm -rf '/workspace/app' && mkdir -p '/workspace/app'",
    );
  });

  it("accepts --yes as an alias for --force", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/files",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_123/exec",
        method: "POST",
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0 } }), {
        headers: { "content-type": "application/json" },
      });

    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "sandbox",
      "sync",
      makeLocalDir(),
      "/workspace/app",
      "--sandbox",
      "sbx_123",
      "--delete",
      "--yes",
    ]);

    expect(process.exit).not.toHaveBeenCalled();
  });
});
