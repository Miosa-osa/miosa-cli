import { describe, it, expect } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { MiosaClient } from "../src/client.js";
import {
  ApiResponseError,
  AuthError,
  NetworkError,
  UserError,
} from "../src/errors.js";
import type { MiosaConfig } from "../src/types.js";

function makeConfig(overrides: Partial<MiosaConfig> = {}): MiosaConfig {
  return {
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_testkey" as import("../src/types.js").ApiKey,
    default_host: null,
    ...overrides,
  };
}

describe("MiosaClient", () => {
  describe("constructor", () => {
    it("should throw if no api_key in config", () => {
      expect(() => new MiosaClient({ ...makeConfig(), api_key: null })).toThrow(
        "You are not logged in.",
      );
    });
  });

  describe("HTTP error mapping", () => {
    it("shows a legacy string error body for HTTP 400", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({ path: "/api/v1/computers", method: "POST" })
        .reply(
          400,
          JSON.stringify({ error: "template_type is required" }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(makeConfig());
      await expect(
        client.apiPost<unknown>("/api/v1/computers", { name: "boris" }),
      ).rejects.toThrow("template_type is required");
    });

    it("should throw AuthError on 401", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(401, JSON.stringify({ error: { message: "Unauthorized" } }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      await expect(client.getTenant()).rejects.toThrow(AuthError);
    });

    it("should throw AuthError on 403", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(403, JSON.stringify({ error: { message: "Forbidden" } }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      await expect(client.getTenant()).rejects.toThrow(AuthError);
    });

    it("should throw UserError on 402 with credits hint", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(
          402,
          JSON.stringify({ error: { message: "Insufficient credits" } }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(makeConfig());
      const err = await client.getTenant().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as UserError).hint).toContain("billing");
    });

    it("should throw UserError on 404", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({
          path: "/api/v1/opencomputers/hosts/not-found",
          method: "GET",
        })
        .reply(404, JSON.stringify({ error: { message: "Not found" } }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      await expect(
        client.get<unknown>("/api/v1/opencomputers/hosts/not-found"),
      ).rejects.toThrow(UserError);
    });

    it("preserves backend error code and request ID", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(
          409,
          JSON.stringify({
            error: {
              code: "SLUG_TAKEN",
              message: "slug is already used",
              details: { slug: "clinic" },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-request-id": "req_123",
            },
          },
        );

      const client = new MiosaClient(makeConfig());
      const err = await client.getTenant().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiResponseError);
      expect((err as ApiResponseError).code).toBe("SLUG_TAKEN");
      expect((err as ApiResponseError).requestId).toBe("req_123");
      expect((err as ApiResponseError).retryable).toBe(false);
    });

    it("preserves structured 422 validation details without debug mode", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      mock
        .get("https://api.miosa.ai")
        .intercept({ path: "/api/v1/sandboxes", method: "POST" })
        .reply(
          422,
          JSON.stringify({
            error: {
              message: "manifest rejected",
              details: {
                fields: [{ path: "services.web.port", code: "taken" }],
              },
            },
          }),
          { headers: { "content-type": "application/json", "x-request-id": "req_validation" } },
        );

      const client = new MiosaClient(makeConfig());
      const error = await client.apiPost("/api/v1/sandboxes", {}).catch((value: unknown) => value);

      expect(error).toBeInstanceOf(ApiResponseError);
      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "manifest rejected",
        details: {
          fields: [{ path: "services.web.port", code: "taken" }],
        },
        requestId: "req_validation",
      });
    });

    it("sends global tenant and workspace scope headers", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({
          path: "/api/v1/platform/tenants/current",
          method: "GET",
          headers: {
            "x-miosa-tenant": "tenant_123",
            "x-miosa-workspace": "workspace_123",
          },
        })
        .reply(
          200,
          JSON.stringify({
            data: {
              id: "tenant_123",
              name: "Acme",
              slug: "acme",
              inserted_at: "2026-01-01T00:00:00Z",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(
        makeConfig({ tenant: "tenant_123", workspace: "workspace_123" }),
      );
      await expect(client.getTenant()).resolves.toMatchObject({
        id: "tenant_123",
      });
    });

    it("should return tenant data on 200", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const tenant = {
        id: "t_123",
        name: "Acme Corp",
        slug: "acme",
        plan: "pro",
        credit_balance: 5000,
        inserted_at: "2024-01-01T00:00:00Z",
      };

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(200, JSON.stringify({ data: tenant }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      const result = await client.getTenant();
      expect(result.name).toBe("Acme Corp");
      expect(result.plan).toBe("pro");
      expect(result.credit_balance).toBe(5000);
    });

    it("accepts tenant envelope responses", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(
          200,
          JSON.stringify({
            tenant: {
              id: "t_123",
              name: "Envelope Corp",
              slug: "envelope",
              plan_name: "free",
              inserted_at: "2024-01-01T00:00:00Z",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(makeConfig());
      const result = await client.getTenant();
      expect(result.name).toBe("Envelope Corp");
      expect(result.slug).toBe("envelope");
      expect(result.plan).toBe("free");
    });

    it("throws a readable UserError when tenant response is empty", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(200, JSON.stringify({}), {
          headers: { "content-type": "application/json" },
      });

      const client = new MiosaClient(makeConfig());
      const err = await client.getTenant().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as Error).message).toBe(
        "MIOSA returned an invalid account response.",
      );
    });

    it("throws a readable UserError when tenant response has no name", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(200, JSON.stringify({ data: { slug: "missing-name" } }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      await expect(client.getTenant()).rejects.toThrow(UserError);
    });

    it("should hydrate tenant credits from billing overview when tenant response omits legacy balance", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const tenant = {
        id: "t_123",
        name: "Acme Corp",
        slug: "acme",
        plan_name: "Platform",
        inserted_at: "2024-01-01T00:00:00Z",
      };

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(200, JSON.stringify(tenant), {
          headers: { "content-type": "application/json" },
        });
      pool
        .intercept({ path: "/api/v1/billing/overview", method: "GET" })
        .reply(
          200,
          JSON.stringify({
            data: {
              usage_budget_cents: 4900,
              topup_balance_cents: 2700,
              billing_period_usage_cents: 1250,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(makeConfig());
      const result = await client.getTenant();
      expect(result.name).toBe("Acme Corp");
      expect(result.plan).toBe("Platform");
      expect(result.credit_balance).toBe(6350);
    });

    it("prefers explicit available balance from billing overview", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const tenant = {
        id: "t_123",
        name: "Acme Corp",
        slug: "acme",
        plan_name: "Platform",
        inserted_at: "2024-01-01T00:00:00Z",
      };

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(200, JSON.stringify({ data: tenant }), {
          headers: { "content-type": "application/json" },
        });
      pool
        .intercept({ path: "/api/v1/billing/overview", method: "GET" })
        .reply(
          200,
          JSON.stringify({
            data: {
              available_balance_cents: 500,
              usage_budget_cents: 4900,
              topup_balance_cents: 2700,
              billing_period_usage_cents: 1250,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );

      const client = new MiosaClient(makeConfig());
      const result = await client.getTenant();
      expect(result.credit_balance).toBe(500);
    });

    it("should list hosts and return array", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const hosts = [
        {
          id: "h_abc123",
          name: "my-mac",
          state: "online",
          os: "macOS",
          platform: "darwin",
          arch: "arm64",
          hostname: "Roberts-MacBook.local",
          last_heartbeat: new Date().toISOString(),
          host_key: null,
          install_command: null,
          tenant_id: "t_123",
          inserted_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/opencomputers/hosts", method: "GET" })
        .reply(200, JSON.stringify({ data: hosts }), {
          headers: { "content-type": "application/json" },
        });

      const client = new MiosaClient(makeConfig());
      const result = await client.listHosts();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("my-mac");
      expect(result[0]?.state).toBe("online");
    });

    it("should throw UserError on 429 rate limit", async () => {
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);

      const pool = mock.get("https://api.miosa.ai");
      pool
        .intercept({ path: "/api/v1/platform/tenants/current", method: "GET" })
        .reply(
          429,
          JSON.stringify({ error: { message: "Too many requests" } }),
          {
            headers: { "content-type": "application/json" },
          },
        );

      const client = new MiosaClient(makeConfig());
      await expect(client.getTenant()).rejects.toThrow(UserError);
    });
  });
});

// Expose get for test access
declare module "../src/client.js" {
  interface MiosaClient {
    get<T>(path: string): Promise<T>;
  }
}
