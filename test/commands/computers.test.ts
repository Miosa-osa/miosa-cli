import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    tenant: null,
    workspace: null,
  }),
}));

const { register } = await import("../../src/commands/computers.js");

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

describe("miosa computers", () => {
  beforeEach(() => {
    delete process.env["MIOSA_JSON"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
    process.exitCode = undefined;
  });

  it("creates a desktop from the documented name-only command", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/computers",
        method: "POST",
        body: JSON.stringify({
          name: "boris",
          template_type: "miosa-desktop",
          size: "small",
          region: "us-mia",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "cmp_boris",
            name: "boris",
            status: "provisioning",
            template_type: "miosa-desktop",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "create",
      "--name",
      "boris",
    ]);

    expect(JSON.parse(logged.join("\n"))).toMatchObject({
      id: "cmp_boris",
      name: "boris",
      template_type: "miosa-desktop",
    });
  });

  it("sends compute_placement_request for an opencomputers-targeted computer", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const hostId = "33333333-3333-3333-3333-333333333333";

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/computers",
        method: "POST",
        body: JSON.stringify({
          name: "boris",
          template_type: "miosa-desktop",
          size: "small",
          region: "us-mia",
          compute_placement_request: {
            provider: "opencomputers",
            host_id: hostId,
          },
        }),
      })
      .reply(
        201,
        JSON.stringify({ data: { id: "cmp_boris", name: "boris" } }),
        { headers: { "content-type": "application/json" } },
      );

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "create",
      "--name",
      "boris",
      "--provider",
      "opencomputers",
      "--host-id",
      hostId,
    ]);
  });

  it("shows the one-time viewer password with a clear access explanation", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/computers",
        method: "POST",
        body: JSON.stringify({
          name: "boris",
          template_type: "miosa-desktop",
          size: "small",
          region: "us-mia",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          id: "cmp_boris",
          name: "boris",
          status: "provisioning",
          viewer_password: "TEMP-VIEWER-PASSWORD",
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "create",
      "--name",
      "boris",
    ]);

    const output = logged.join("\n");
    expect(output).toContain("TEMP-VIEWER-PASSWORD");
    expect(output).toContain("shown once");
    expect(output).toContain("Signed-in access");
    expect(output).toContain("miosa computers open boris");
  });

  it("opens a passwordless authenticated desktop URL", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool.intercept({ path: "/api/v1/computers", method: "GET" }).reply(
      200,
      JSON.stringify([
        {
          id: "cmp_boris",
          name: "boris",
          status: "active",
        },
      ]),
      { headers: { "content-type": "application/json" } },
    );
    pool
      .intercept({
        path: "/api/v1/computers/cmp_boris/embed",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          embed_url:
            "https://boris.computer.miosa.ai/viewer?auth=short-lived-token",
          expires_at: 1_785_000_000,
          auth: {
            mode: "query_token",
            password_required: false,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "open",
      "boris",
      "--print-url",
    ]);

    expect(logged.join("\n")).toContain(
      "https://boris.computer.miosa.ai/viewer?auth=short-lived-token",
    );
  });

  it("runs a command on a computer by its friendly name", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://api.miosa.ai");
    pool.intercept({ path: "/api/v1/computers", method: "GET" }).reply(
      200,
      JSON.stringify([
        {
          id: "cmp_boris",
          name: "boris",
          status: "running",
        },
      ]),
      { headers: { "content-type": "application/json" } },
    );
    pool
      .intercept({
        path: "/api/v1/computers/cmp_boris/exec",
        method: "POST",
        body: JSON.stringify({ command: "pwd" }),
      })
      .reply(
        200,
        'data: {"type":"stdout","data":"/home/ubuntu\\n"}\n\n' +
          'data: {"type":"exit","exit_code":0}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "exec",
      "boris",
      "pwd",
    ]);

    expect(written.join("")).toContain("/home/ubuntu");
    expect(process.exitCode).toBe(0);
  });

  it("prints JSON for create when global JSON mode is active", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/computers",
        method: "POST",
        body: JSON.stringify({
          template_type: "miosa-desktop",
          size: "xs",
          name: "json-computer",
          region: "us-mia",
          agent_runtime_profile_id: "profile_123",
        }),
      })
      .reply(
        201,
        JSON.stringify({
          data: {
            id: "cmp_123",
            name: "json-computer",
            status: "provisioning",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    const logged = captureLogs();
    await buildProgram().parseAsync([
      "node",
      "miosa",
      "computers",
      "create",
      "--name",
      "json-computer",
      "--agent-profile",
      "profile_123",
      "--data",
      '{"template_type":"miosa-desktop","size":"xs"}',
    ]);

    expect(JSON.parse(logged.join("\n"))).toEqual({
      id: "cmp_123",
      name: "json-computer",
      status: "provisioning",
    });
  });

  it("downloads and exports computer files", async () => {
    process.env["MIOSA_JSON"] = "1";
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-cli-computer-"),
    );
    const output = path.join(tmpDir, "report.txt");

    const pool = mock.get("https://api.miosa.ai");
    pool
      .intercept({
        path: "/api/v1/computers/cmp_123/files/download?path=%2Fworkspace%2Freport.txt",
        method: "GET",
      })
      .reply(200, "computer file", {
        headers: { "content-type": "text/plain" },
      });
    pool
      .intercept({
        path: "/api/v1/computers/cmp_123/files/export",
        method: "POST",
        body: JSON.stringify({ path: "/workspace/report.txt" }),
      })
      .reply(200, JSON.stringify({ data: { success: true } }), {
        headers: { "content-type": "application/json" },
      });

    const logged = captureLogs();
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "miosa",
      "computers",
      "download",
      "cmp_123",
      "/workspace/report.txt",
      "--output",
      output,
    ]);
    await program.parseAsync([
      "node",
      "miosa",
      "computers",
      "export",
      "cmp_123",
      "/workspace/report.txt",
    ]);

    expect(fs.readFileSync(output, "utf8")).toBe("computer file");
    const outputs = logged.map((entry) => JSON.parse(entry));
    expect(outputs[0]).toMatchObject({
      computer_id: "cmp_123",
      remote_path: "/workspace/report.txt",
      output,
      bytes: 13,
    });
    expect(outputs[1]).toEqual({ success: true });
  });
});
