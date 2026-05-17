import { describe, it, expect } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { MiosaClient } from "../src/client.js";
import { AuthError, NetworkError, UserError } from "../src/errors.js";
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
