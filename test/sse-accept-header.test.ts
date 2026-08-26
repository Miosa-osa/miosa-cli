import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MiosaClient } from "../src/client.js";
import type { ComputerId, DeploymentId, BuildId, HostId } from "../src/types.js";

/**
 * Every route that returns a genuine `text/event-stream` must be opened with an
 * Accept header that asks for it. A route sitting behind Phoenix's
 * `plug :accepts, ["json"]` raises Phoenix.NotAcceptableError (HTTP 406) before
 * the controller runs, so this header is what decides whether streaming works
 * at all (2026-08-26: three SDK-facing routes were fixed server-side for
 * exactly this).
 */

const ENDPOINT = "https://api.miosa.ai";

let mock: MockAgent;

function client(): MiosaClient {
  return new MiosaClient({
    endpoint: ENDPOINT,
    api_key: "msk_u_test",
    default_host: null,
    region: null,
    output: "text",
    tenant: "acme",
    organization: "acme",
    workspace: "ws_1",
    quiet: false,
    debug: false,
  });
}

/** Record the Accept header the client sent for one intercepted call. */
function captureAccept(
  path: string,
  method: "GET" | "POST",
): { accept: () => string | undefined; scope: () => Record<string, unknown> } {
  let headers: Record<string, unknown> = {};
  mock
    .get(ENDPOINT)
    .intercept({ path, method })
    .reply(200, (opts) => {
      headers = (opts.headers ?? {}) as Record<string, unknown>;
      return "";
    }, { headers: { "content-type": "text/event-stream" } });

  return {
    accept: () => {
      const value = headers["Accept"] ?? headers["accept"];
      return typeof value === "string" ? value : undefined;
    },
    scope: () => headers,
  };
}

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});

afterEach(async () => {
  await mock.close();
});

describe("SSE Accept headers", () => {
  it("apiStream asks for text/event-stream", async () => {
    const captured = captureAccept("/api/v1/runs/run_1/activity", "GET");

    const res = await client().apiStream("/api/v1/runs/run_1/activity");
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("asks only for text/event-stream, never a widened Accept", async () => {
    // The database log stream used to send
    // `text/event-stream, application/json, */*` to dodge a JSON-only
    // pipeline. That workaround turned a misconfigured route into a 200 with a
    // JSON body, which yields no SSE frames and so prints nothing at all. The
    // narrow Accept makes the same misconfiguration a loud 406 instead.
    const captured = captureAccept("/api/v1/databases/db_1/logs/stream", "GET");

    const res = await client().apiStream(
      "/api/v1/databases/db_1/logs/stream",
    );
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("apiStream still carries the tenant and workspace scope headers", async () => {
    // The database-log stream used to be a hand-rolled undici call that omitted
    // these, so that one command resolved against a different scope than every
    // other command.
    const captured = captureAccept("/api/v1/databases/db_1/logs/stream", "GET");

    const res = await client().apiStream(
      "/api/v1/databases/db_1/logs/stream",
    );
    await res.body.dump();

    const headers = captured.scope();
    expect(headers["X-MIOSA-Tenant"] ?? headers["x-miosa-tenant"]).toBe("acme");
    expect(headers["X-MIOSA-Workspace"] ?? headers["x-miosa-workspace"]).toBe(
      "ws_1",
    );
  });

  it("computerExec asks for text/event-stream", async () => {
    const captured = captureAccept("/api/v1/computers/cmp_1/exec", "POST");

    const res = await client().computerExec("cmp_1" as ComputerId, "ls");
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("watchComputerEvents asks for text/event-stream", async () => {
    const captured = captureAccept("/api/v1/computers/cmp_1/events", "GET");

    const res = await client().watchComputerEvents("cmp_1" as ComputerId);
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("streamJob asks for text/event-stream", async () => {
    const captured = captureAccept(
      "/api/v1/opencomputers/hosts/host_1/jobs",
      "POST",
    );

    const res = await client().streamJob("host_1" as HostId, {
      command: "echo hi",
    });
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("streamDeploymentLogs asks for text/event-stream", async () => {
    const captured = captureAccept("/api/v1/deployments/dep_1/logs", "GET");

    const res = await client().streamDeploymentLogs("dep_1" as DeploymentId);
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("streamBuildLogs asks for text/event-stream", async () => {
    const captured = captureAccept(
      "/api/v1/deployments/dep_1/builds/bld_1/logs",
      "GET",
    );

    const res = await client().streamBuildLogs(
      "dep_1" as DeploymentId,
      "bld_1" as BuildId,
    );
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });

  it("dispatchAgent asks for text/event-stream", async () => {
    const captured = captureAccept(
      "/api/v1/opencomputers/hosts/host_1/agent/dispatch",
      "POST",
    );

    const res = await client().dispatchAgent("host_1" as HostId, {
      prompt: "hello",
    });
    await res.body.dump();

    expect(captured.accept()).toBe("text/event-stream");
  });
});

describe("a 406 from a streaming route", () => {
  it("is reported as a server-side negotiation fault, not a user error", async () => {
    mock
      .get(ENDPOINT)
      .intercept({ path: "/api/v1/runs/run_1/activity", method: "GET" })
      .reply(
        406,
        JSON.stringify({ error: { message: "no acceptable format" } }),
        { headers: { "content-type": "application/json" } },
      );

    await expect(
      client().apiStream("/api/v1/runs/run_1/activity"),
    ).rejects.toMatchObject({
      message: expect.stringContaining("rejected this request's Accept header"),
      hint: expect.stringContaining("server-side content-negotiation fault"),
    });
  });
});
