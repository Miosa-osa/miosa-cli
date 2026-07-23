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

const browserLogin = vi.fn();

function restoreBrowserLoginMock() {
  browserLogin.mockImplementation(async (_config, tenant: string) => ({ slug: tenant }));
}

vi.mock("../../src/commands/login.js", () => ({
  browserLogin,
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
const { register: registerSandbox } = await import(
  "../../src/commands/sandbox.js"
);
const { register: registerDeploy } = await import(
  "../../src/commands/deploy.js"
);

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

function buildScopedProgram(
  registerCommand: (program: Command) => void,
): Command {
  const program = new Command();
  program.exitOverride();
  registerCommand(program);
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
    restoreBrowserLoginMock();
    browserLogin.mockClear();
    fs.rmSync(path.join(TEST_HOME, ".miosa"), {
      recursive: true,
      force: true,
    });
    delete process.env["MIOSA_TENANT"];
    delete process.env["MIOSA_WORKSPACE"];
    delete process.env["MIOSA_JSON"];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    saveConfig({
      api_key: "msk_u_test" as never,
      tenant: "osa",
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

  it("scopes sandbox and deployment commands to the selected tenant without OSA fallback", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(200, JSON.stringify({ data: tenants }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/sandboxes",
        method: "GET",
        headers: { "x-miosa-tenant": "clinic-iq" },
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    pool
      .intercept({
        path: "/api/v1/deployments",
        method: "GET",
        headers: { "x-miosa-tenant": "clinic-iq" },
      })
      .reply(200, JSON.stringify({ data: [] }), {
        headers: { "content-type": "application/json" },
      });
    setGlobalDispatcher(mock);

    await switchTenant("clinic-iq");
    await buildScopedProgram(registerSandbox).parseAsync([
      "node",
      "miosa",
      "sandbox",
      "list",
      "--json",
    ]);
    await buildScopedProgram(registerDeploy).parseAsync([
      "node",
      "miosa",
      "deploy",
      "list",
      "--json",
    ]);

    expect(loadConfig().tenant).toBe("clinic-iq");
    expect(loadContextStore().contexts["operator"]?.tenant).toBe("clinic-iq");
    expect(mock.pendingInterceptors()).toEqual([]);
  });

  it("preserves the current tenant when the API key is refused for another tenant", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/platform/tenants", method: "GET" })
      .reply(
        403,
        JSON.stringify({
          error: {
            code: "TENANT_API_KEY_MISMATCH",
            message: "API key does not belong to tenant clinic-iq",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    setGlobalDispatcher(mock);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });

    await expect(switchTenant("clinic-iq")).rejects.toThrow("process.exit(3)");

    expect(loadConfig().tenant).toBe("osa");
    expect(loadContextStore()).toMatchObject({
      active: "operator",
      contexts: { operator: { tenant: "osa" } },
    });
  });
});
