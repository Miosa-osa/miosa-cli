import { describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import {
  ActionAuthorityClient,
  canonicalJson,
  fingerprint,
} from "../src/action-authority.js";
import { MiosaClient } from "../src/client.js";
import type { ApiKey, MiosaConfig } from "../src/types.js";

function client(): ActionAuthorityClient {
  const config: MiosaConfig = {
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test" as ApiKey,
    default_host: null,
    region: null,
    output: "human",
    tenant: "clinic-iq",
    workspace: null,
  };
  return new ActionAuthorityClient(new MiosaClient(config));
}

describe("ActionAuthorityClient", () => {
  it("canonicalizes objects independent of key insertion order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  });

  it("uses only the server-published capability fingerprint", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    const pool = mock.get("https://api.miosa.ai");

    pool
      .intercept({ path: "/api/v1/actions/catalog", method: "GET" })
      .reply(200, {
        data: [
          {
            name: "computer.destroy",
            version: "1.0.0",
            fingerprint: `sha256:${"a".repeat(64)}`,
            risk: "destructive",
            scope: "computer",
            approval: "always",
          },
        ],
      });

    pool
      .intercept({
        path: "/api/v1/actions/authorize",
        method: "POST",
        body: (body) => {
          const parsed = JSON.parse(body as string) as {
            capability: { fingerprint: string };
            params_fingerprint: string;
            request_fingerprint: string;
          };
          return (
            parsed.capability.fingerprint === `sha256:${"a".repeat(64)}` &&
            parsed.params_fingerprint.startsWith("sha256:") &&
            parsed.request_fingerprint.startsWith("sha256:")
          );
        },
      })
      .reply(202, {
        decision: "pending_approval",
        approval_request_id: "approval-1",
        receipt_id: "receipt-1",
      });

    await expect(
      client().authorize("computer.destroy", { id: "computer-1" }),
    ).resolves.toMatchObject({
      decision: "pending_approval",
      approval_request_id: "approval-1",
    });
  });

  it("fails before authorization when the capability is not registered", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    mock
      .get("https://api.miosa.ai")
      .intercept({ path: "/api/v1/actions/catalog", method: "GET" })
      .reply(200, { data: [] });

    await expect(client().authorize("unknown.action", {})).rejects.toThrow(
      "is not registered",
    );
  });
});
