import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
  ora: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

const { parseDotenv, readEnvFile, resolveEnvInputs } =
  await import("../../src/commands/env-input.js");
const { register: registerSandbox } =
  await import("../../src/commands/sandbox.js");
const { register: registerEnv } = await import("../../src/commands/env.js");
const { register: registerDeploy } =
  await import("../../src/commands/deploy.js");

// Byte-exact values that shells would mangle if passed inline unquoted.
const SCRYPT_HASH = "$scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA";
const JSON_BLOB = '{"key": "va$lue", "hash": "#fff", "n": 1}';
const UNICODE = "héllo wörld 🚀";

const DOTENV_FIXTURE = [
  "# comment line",
  `HASH=${SCRYPT_HASH}`,
  `SINGLE='literal $N and "double quotes" kept'`,
  `DOUBLE="line1\\nline2 with 'single' and $r"`,
  `MULTILINE="first line`,
  `second line"`,
  `PADDED="  spaces kept  "`,
  `JSON_BLOB='${JSON_BLOB}'`,
  `UNICODE=${UNICODE}`,
  "export EXPORTED=yes",
  "INLINE_COMMENT=value # trailing comment",
  "EMPTY=",
  "",
].join("\n");

const EXPECTED_FIXTURE_ENV: Record<string, string> = {
  HASH: SCRYPT_HASH,
  SINGLE: 'literal $N and "double quotes" kept',
  DOUBLE: "line1\nline2 with 'single' and $r",
  MULTILINE: "first line\nsecond line",
  PADDED: "  spaces kept  ",
  JSON_BLOB,
  UNICODE,
  EXPORTED: "yes",
  INLINE_COMMENT: "value",
  EMPTY: "",
};

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function withStdin(content: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", {
    value: Readable.from([Buffer.from(content, "utf8")]),
    configurable: true,
  });
  return () => Object.defineProperty(process, "stdin", original);
}

// ── parseDotenv (no expansion, byte-for-byte) ─────────────────────────────────

describe("parseDotenv", () => {
  it("round-trips $, quotes, spaces, newlines, JSON blobs, and unicode byte-for-byte", () => {
    expect(parseDotenv(DOTENV_FIXTURE)).toEqual(EXPECTED_FIXTURE_ENV);
  });

  it("never expands $VARS — values are literal", () => {
    process.env["SHOULD_NOT_LEAK"] = "leaked";
    const env = parseDotenv("A=$SHOULD_NOT_LEAK\nB='${SHOULD_NOT_LEAK}'\n");
    expect(env["A"]).toBe("$SHOULD_NOT_LEAK");
    expect(env["B"]).toBe("${SHOULD_NOT_LEAK}");
    delete process.env["SHOULD_NOT_LEAK"];
  });

  it("handles CRLF line endings", () => {
    expect(parseDotenv("A=1\r\nB=$two\r\n")).toEqual({ A: "1", B: "$two" });
  });
});

// ── readEnvFile ───────────────────────────────────────────────────────────────

describe("readEnvFile", () => {
  it("reads a dotenv file byte-for-byte", () => {
    const file = writeFixture(DOTENV_FIXTURE);
    expect(readEnvFile(file)).toEqual(EXPECTED_FIXTURE_ENV);
  });

  it("throws a UserError for a missing file", () => {
    expect(() => readEnvFile("/nonexistent/definitely-missing.env")).toThrow(
      /env file/i,
    );
  });
});

// ── resolveEnvInputs precedence ───────────────────────────────────────────────

describe("resolveEnvInputs", () => {
  it("inline overrides file on key conflicts; file-only keys survive", async () => {
    const file = writeFixture("A=from-file\nB=$file-only\n");
    const env = await resolveEnvInputs({ A: "from-inline" }, { envFile: file });
    expect(env).toEqual({ A: "from-inline", B: "$file-only" });
  });

  it("stdin overrides file; inline overrides stdin", async () => {
    const file = writeFixture("A=file\nB=file\nC=file\n");
    const restore = withStdin("B=stdin\nC=stdin\n");
    try {
      const env = await resolveEnvInputs(
        { C: "inline" },
        { envFile: file, envStdin: true },
      );
      expect(env).toEqual({ A: "file", B: "stdin", C: "inline" });
    } finally {
      restore();
    }
  });
});

// ── command wiring ────────────────────────────────────────────────────────────

function buildSandboxProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerSandbox(program);
  return program;
}

function mockApi(): MockAgent {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  return mock;
}

describe("env input command wiring", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sandbox exec --env-file ships file values byte-for-byte", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_env/exec",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "" } }), {
        headers: { "content-type": "application/json" },
      });

    const file = writeFixture(DOTENV_FIXTURE);
    await buildSandboxProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_env",
      "--env-file",
      file,
      "printenv",
    ]);

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual(EXPECTED_FIXTURE_ENV);
  });

  it("sandbox exec: inline --env overrides --env-file on conflicts", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_env/exec",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "" } }), {
        headers: { "content-type": "application/json" },
      });

    const file = writeFixture("A=from-file\nB=kept\n");
    await buildSandboxProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "exec",
      "sbx_env",
      "--env",
      "A=from-inline",
      "--env-file",
      file,
      "printenv",
    ]);

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual({ A: "from-inline", B: "kept" });
  });

  it("sandbox run --env-stdin reads KEY=VALUE lines literally", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_env/exec",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: { exit_code: 0, stdout: "" } }), {
        headers: { "content-type": "application/json" },
      });

    const restore = withStdin(`TOKEN=${SCRYPT_HASH}\n`);
    try {
      await buildSandboxProgram().parseAsync([
        "node",
        "miosa",
        "sandbox",
        "run",
        "sbx_env",
        "--env-stdin",
        "printenv",
      ]);
    } finally {
      restore();
    }

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual({ TOKEN: SCRYPT_HASH });
  });

  it("sandbox prompt --env-file ships file values on the agent run", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/agent-runs",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(
        200,
        JSON.stringify({ data: { id: "run_1", status: "completed" } }),
        { headers: { "content-type": "application/json" } },
      );

    const file = writeFixture(`SECRET=${SCRYPT_HASH}\n`);
    await buildSandboxProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "prompt",
      "sbx_env",
      "--env-file",
      file,
      "--json",
      "do",
      "things",
    ]);

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual({ SECRET: SCRYPT_HASH });
  });

  it("sandbox env set --env-file ships vars byte-for-byte", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes/sbx_env/env",
        method: "PUT",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: { updated: 2 } }), {
        headers: { "content-type": "application/json" },
      });

    const file = writeFixture(
      `HASH=${SCRYPT_HASH}\nJSON_BLOB='${JSON_BLOB}'\n`,
    );
    await buildSandboxProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "env",
      "set",
      "sbx_env",
      "--env-file",
      file,
    ]);

    const body = JSON.parse(captured) as {
      vars: Array<{ key: string; value: string }>;
    };
    expect(body.vars).toEqual([
      { key: "HASH", value: SCRYPT_HASH },
      { key: "JSON_BLOB", value: JSON_BLOB },
    ]);
  });

  it("sandbox env set errors when no pairs, file, or stdin are given", async () => {
    mockApi();
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });

    await buildSandboxProgram().parseAsync([
      "node",
      "miosa",
      "sandbox",
      "env",
      "set",
      "sbx_env",
    ]);

    expect(errors.join("\n")).toMatch(/no env vars/i);
  });

  it("env set --env-file ships deployment env byte-for-byte", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_1/env",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = new Command();
    program.exitOverride();
    registerEnv(program);
    await program.parseAsync([
      "node",
      "miosa",
      "env",
      "set",
      "dep_1",
      "--env-file",
      writeFixture(`HASH=${SCRYPT_HASH}\nUNICODE=${UNICODE}\n`),
    ]);

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual({ HASH: SCRYPT_HASH, UNICODE });
  });

  it("deploy env set --env-file ships deployment env byte-for-byte", async () => {
    const mock = mockApi();
    let captured = "";
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/deployments/dep_1/env",
        method: "POST",
        body: (body: string) => {
          captured = body;
          return true;
        },
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });

    const program = new Command();
    program.exitOverride();
    registerDeploy(program);
    await program.parseAsync([
      "node",
      "miosa",
      "deploy",
      "env",
      "set",
      "--id",
      "dep_1",
      "--env-file",
      writeFixture(`HASH=${SCRYPT_HASH}\n`),
      "PLAIN=ok",
    ]);

    const body = JSON.parse(captured) as { env: Record<string, string> };
    expect(body.env).toEqual({ HASH: SCRYPT_HASH, PLAIN: "ok" });
  });
});
