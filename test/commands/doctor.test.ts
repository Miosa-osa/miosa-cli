import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { detectMcpInstall, doctorVerdict } = await import(
  "../../src/commands/doctor.js"
);

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
});

describe("doctorVerdict reconciles ok / firstFailure / summary", () => {
  it("keeps ok:true with firstFailure:null when only optional warnings are present", () => {
    // The exact reported inconsistency: soft warnings must not make ok:false.
    const verdict = doctorVerdict(
      [
        { name: "API key", ok: true, detail: "msk_...redacted" },
        { name: "DNS", ok: true, layer: "dns", detail: "resolved" },
        { name: "Credentials", ok: true, layer: "auth", detail: "valid (Acme)" },
        {
          name: "miosa-mcp",
          ok: false,
          warn: true,
          detail: "not installed",
          fix: "pip install miosa-mcp",
        },
        { name: ".claude/mcp.json", ok: false, warn: true, detail: "not found" },
        {
          name: "Action authority",
          ok: false,
          warn: true,
          detail: "catalog mismatch: missing 2",
        },
      ],
      {
        firstFailure: null,
        summary:
          "All layers healthy: DNS, TCP, TLS, /health, and credentials for api.miosa.ai.",
      },
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.firstFailure).toBeNull();
    expect(verdict.summary).toContain("All layers healthy");
    expect(verdict.warnings.map((w) => w.name)).toEqual([
      "miosa-mcp",
      ".claude/mcp.json",
      "Action authority",
    ]);
  });

  it("names the failing transport layer when a required layer fails", () => {
    const verdict = doctorVerdict(
      [
        { name: "DNS", ok: true, layer: "dns", detail: "resolved" },
        {
          name: "TLS",
          ok: false,
          layer: "tls",
          detail: "certificate expired",
          fix: "renew the certificate",
        },
        {
          name: "/health",
          ok: false,
          unknown: true,
          layer: "http",
          detail: "not determined - TLS failed first",
        },
        { name: "miosa-mcp", ok: false, warn: true, detail: "not installed" },
      ],
      {
        firstFailure: "tls",
        summary:
          "TLS failed: certificate expired. Everything below it is UNVERIFIED, not healthy.",
      },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.firstFailure).toBe("tls");
    expect(verdict.summary).toContain("TLS failed");
    // An unknown layer is not a hard failure and not a warning.
    expect(verdict.warnings.map((w) => w.name)).toEqual(["miosa-mcp"]);
  });

  it("names a required non-transport check when transport is clean but it fails", () => {
    const verdict = doctorVerdict(
      [
        { name: "DNS", ok: true, layer: "dns", detail: "resolved" },
        { name: "Node.js", ok: false, detail: "v18.0.0", fix: "Node.js 20+" },
      ],
      {
        firstFailure: null,
        summary: "All layers healthy: DNS, TCP, TLS, /health, and credentials.",
      },
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.firstFailure).toBe("Node.js");
    expect(verdict.summary).toBe("Node.js failed: v18.0.0");
  });
});
