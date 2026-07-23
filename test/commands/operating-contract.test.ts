import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_test",
    organization: "org_123",
    tenant: "org_123",
    workspace: "ws_123",
  }),
}));

vi.mock("../../src/commands/sandbox.js", () => ({
  deploySandbox: vi.fn(),
}));

const { register } = await import("../../src/commands/operating-contract.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

async function run(args: string[]): Promise<string> {
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  });
  await buildProgram().parseAsync(["node", "miosa", ...args]);
  return logged.join("\n");
}

describe("capability operating contract commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it.each([
    "changes",
    "placement",
    "incidents",
    "drift",
    "blueprint",
    "wait",
    "policy",
    "evidence",
    "memory",
  ])("ships CLI help for %s", async (family) => {
    const command = buildProgram().commands.find(
      (candidate) => candidate.name() === family,
    );
    expect(command).toBeDefined();
    expect(command?.description()).not.toBe("");
    expect(command?.commands.length).toBeGreaterThan(0);
    expect(command?.helpInformation()).toContain(family);
    expect(command?.helpInformation()).toContain("Options:");
  });

  it("validates a capability manifest through the CLI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-blueprint-"));
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: customer-app
organization: org_123
workspace: ws_123
application: customer-app
environment: production
dependencies:
  install: npm ci
services:
  web:
    command: npm start
    port: 3000
capabilities:
  routes:
    - id: root
      path: /
      expected_status: [200]
  database:
    required: true
    health_path: /api/health
    migration:
      required: true
  connectors:
    - id: oauth
  jobs:
    - id: daily-sync
policy:
  approvals_required: 1
  allowed_environments: [production]
`,
    );

    const result = JSON.parse(
      await run(["blueprint", "validate", dir, "--json"]),
    ) as { ok: boolean; data: { valid: boolean } };
    expect(result.ok).toBe(true);
    expect(result.data.valid).toBe(true);
  });

  it("records and reads operator memory without changing deployment state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-memory-"));
    const recorded = JSON.parse(
      await run(["memory", "record", "keep old release live", dir, "--json"]),
    ) as { data: { message: string } };
    vi.restoreAllMocks();
    const listed = JSON.parse(
      await run(["memory", "list", dir, "--json"]),
    ) as { data: { entries: Array<{ message: string }> } };

    expect(recorded.data.message).toBe("keep old release live");
    expect(listed.data.entries).toEqual([
      expect.objectContaining({ message: "keep old release live" }),
    ]);
  });
});
