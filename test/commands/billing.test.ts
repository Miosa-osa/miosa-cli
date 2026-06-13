import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
    tenant: null,
    workspace: null,
    quiet: false,
    debug: false,
  }),
}));

vi.mock("../../src/ui/spinner.js", () => ({
  spin: () => ({
    text: "",
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  }),
}));

const { register } = await import("../../src/commands/billing.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

const overview = {
  plan_name: "enterprise",
  currency: "usd",
  usage_budget_cents: 10_000,
  topup_balance_cents: 4_923_488,
  billing_period_usage_cents: 81_672,
  available_balance_cents: 4_851_816,
  billing_period_start: "2026-05-07T13:16:53.583205Z",
  billing_period_end: "2126-03-18T13:18:18.658228Z",
  subscription: {
    status: "active",
    current_period_end: "2126-03-18T13:18:18.658228Z",
  },
};

describe("miosa billing", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    process.env["MIOSA_JSON"] = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["MIOSA_JSON"];
  });

  it("prints JSON for plan when root JSON mode is active", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/billing/overview", method: "GET" })
      .reply(200, JSON.stringify({ data: overview }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync(["node", "miosa", "billing", "plan"]);

    const parsed = JSON.parse(logged.join("")) as typeof overview;
    expect(parsed.plan_name).toBe("enterprise");
    expect(parsed.available_balance_cents).toBe(4_851_816);
  });

  it("prints JSON for usage when root JSON mode is active", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/billing/overview", method: "GET" })
      .reply(200, JSON.stringify({ data: overview }), {
        headers: { "content-type": "application/json" },
      });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await buildProgram().parseAsync(["node", "miosa", "billing", "usage"]);

    const parsed = JSON.parse(logged.join("")) as typeof overview;
    expect(parsed.billing_period_usage_cents).toBe(81_672);
    expect(parsed.topup_balance_cents).toBe(4_923_488);
  });
});
