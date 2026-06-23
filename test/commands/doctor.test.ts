import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { checkMcpJson, detectMcpInstall } = await import("../../src/commands/doctor.js");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  fs.chmodSync(file, 0o755);
}

describe("miosa doctor MCP detection", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an executable that asks for MIOSA_API_KEY as installed", async () => {
    const dir = makeTempDir();
    const exe = path.join(dir, "miosa-mcp");
    writeExecutable(
      exe,
      [
        "#!/usr/bin/env sh",
        "echo 'Error: MIOSA_API_KEY environment variable is not set.' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );

    const detected = await detectMcpInstall({
      mcpCommands: [{ command: exe, args: ["--version"], source: "fixture" }],
      env: { ...process.env },
    });

    expect(detected.installed).toBe(true);
    expect(detected.detail).toContain("version unavailable");
    expect(detected.detail).toContain("MIOSA_API_KEY");
  });

  it("finds Windows Python Scripts installs that are not on PATH", async () => {
    const root = makeTempDir();
    const exe = path.join(
      root,
      "Programs",
      "Python",
      "Python314",
      "Scripts",
      "miosa-mcp.exe",
    );
    writeExecutable(
      exe,
      ["#!/usr/bin/env sh", "echo 'miosa-mcp 0.2.1'", ""].join("\n"),
    );

    const detected = await detectMcpInstall({
      env: { ...process.env, LOCALAPPDATA: root },
      platform: "win32",
      includeDefaultCandidates: false,
    });

    expect(detected.installed).toBe(true);
    expect(detected.detail).toBe("v0.2.1");
    expect(detected.source).toBe("python-scripts");
  });

  it("treats local miosa mcp serve config as configured", async () => {
    const dir = makeTempDir();
    const config = path.join(dir, ".claude.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          miosa: {
            command: "miosa",
            args: ["mcp", "serve"],
          },
        },
      }),
      "utf8",
    );

    const detected = await checkMcpJson([config]);

    expect(detected.found).toBe(true);
    expect(detected.configured).toBe(true);
    expect(detected.commands[0]).toMatchObject({
      command: "miosa",
      args: ["--version"],
      source: config,
    });
  });

  it("does not let an empty project config mask a configured user config", async () => {
    const dir = makeTempDir();
    const emptyProjectConfig = path.join(dir, "project-mcp.json");
    const configuredUserConfig = path.join(dir, "claude.json");
    fs.writeFileSync(emptyProjectConfig, JSON.stringify({ mcpServers: {} }), "utf8");
    fs.writeFileSync(
      configuredUserConfig,
      JSON.stringify({
        mcpServers: {
          miosa: {
            command: "miosa",
            args: ["mcp", "serve"],
          },
        },
      }),
      "utf8",
    );

    const detected = await checkMcpJson([emptyProjectConfig, configuredUserConfig]);

    expect(detected.found).toBe(true);
    expect(detected.configured).toBe(true);
    expect(detected.paths).toEqual([emptyProjectConfig, configuredUserConfig]);
  });
});
