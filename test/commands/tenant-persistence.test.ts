import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent, setGlobalDispatcher } from "undici";

const TEST_HOME = fs.mkdtempSync(
  path.join(os.tmpdir(), "miosa-tenant-persistence-test-"),
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME } };
});

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

const {
  applyNamedContext,
  contextFromConfig,
  loadConfig,
  loadContextStore,
  saveConfig,
  saveNamedContext,
} = await import("../../src/config.js");
const { register } = await import("../../src/commands/tenant.js");

const tenants = [
  {
    id: "tenant-panther",
    name: "Panther Defense",
    slug: "panther-defense",
    plan: "pro",
  },
  {
    id: "tenant-clinic",
    name: "Clinic IQ",
    slug: "clinic-iq",
    plan: "pro",
  },
];

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

function mockTenantList(times = 1): void {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const pool = mock.get("https://api.miosa.ai");

  for (let index = 0; index < times; index += 1) {
    pool
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: tenants }), {
        headers: { "content-type": "application/json" },
      });
  }

  setGlobalDispatcher(mock);
}

async function switchTenant(slug: string): Promise<void> {
  await buildProgram().parseAsync([
    "node",
    "miosa",
    "tenant",
    "switch",
    slug,
    "--json",
  ]);
}

describe("miosa tenant switch context persistence", () => {
  beforeEach(() => {
    fs.rmSync(path.join(TEST_HOME, ".miosa"), {
      recursive: true,
      force: true,
    });
    delete process.env["MIOSA_TENANT"];
    delete process.env["MIOSA_WORKSPACE"];
    vi.spyOn(console, "log").mockImplementation(() => {});

    saveConfig({
      api_key: "msk_u_test" as never,
      tenant: "personal",
      workspace: "workspace-one",
    });
    saveNamedContext("operator", contextFromConfig("operator"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists consecutive organization switches in config and the active named context", async () => {
    mockTenantList(2);

    await switchTenant("panther-defense");
    expect(loadConfig().tenant).toBe("panther-defense");
    expect(loadContextStore().contexts["operator"]?.tenant).toBe(
      "panther-defense",
    );

    await switchTenant("clinic-iq");
    expect(loadConfig().tenant).toBe("clinic-iq");
    expect(loadContextStore()).toMatchObject({
      active: "operator",
      contexts: {
        operator: {
          tenant: "clinic-iq",
          workspace: "workspace-one",
        },
      },
    });
  });

  it("does not restore a stale tenant when the active context is reapplied", async () => {
    mockTenantList();

    await switchTenant("panther-defense");
    applyNamedContext("operator");

    expect(loadConfig().tenant).toBe("panther-defense");
  });
});
