import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { MiosaClient } from "../../src/client.js";
import {
  MCP_TOOLS,
  dispatchMcpTool,
} from "../../src/commands/mcp.js";

function client(): MiosaClient {
  return new MiosaClient({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
  });
}

describe("TypeScript MCP sandbox size contract", () => {
  let mock: MockAgent;

  beforeEach(() => {
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  });

  afterEach(async () => {
    await mock.close();
  });

  it("advertises only canonical named sizes with small as the default", () => {
    const tool = MCP_TOOLS.find(({ name }) => name === "sandbox_create");
    const properties = tool?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(properties?.["size"]).toEqual(
      expect.objectContaining({
        type: "string",
        enum: ["xs", "small", "medium", "large", "xl"],
        default: "small",
      }),
    );
    expect(properties).not.toHaveProperty("cpu_count");
    expect(properties).not.toHaveProperty("memory_mb");
    expect(properties).not.toHaveProperty("disk_size_mb");
  });

  it("sends small when size is omitted", async () => {
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({ size: "small" }),
      })
      .reply(201, JSON.stringify({ data: { id: "sbx_small" } }), {
        headers: { "content-type": "application/json" },
      });

    const result = await dispatchMcpTool(client(), "sandbox_create", {});

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("sbx_small") }),
    );
    mock.assertNoPendingInterceptors();
  });

  it("sends an explicitly selected canonical size", async () => {
    mock
      .get("https://api.miosa.ai")
      .intercept({
        path: "/api/v1/sandboxes",
        method: "POST",
        body: JSON.stringify({
          name: "large-job",
          template_id: "miosa-sandbox",
          size: "xl",
          timeout_sec: 900,
        }),
      })
      .reply(201, JSON.stringify({ data: { id: "sbx_xl" } }), {
        headers: { "content-type": "application/json" },
      });

    const result = await dispatchMcpTool(client(), "sandbox_create", {
      name: "large-job",
      template_id: "miosa-sandbox",
      size: "xl",
      timeout_sec: 900,
    });

    expect(result.isError).not.toBe(true);
    mock.assertNoPendingInterceptors();
  });

  it("rejects raw or invalid resource requests before calling the API", async () => {
    const raw = await dispatchMcpTool(client(), "sandbox_create", {
      cpu_count: 2,
      memory_mb: 4096,
    });
    const invalid = await dispatchMcpTool(client(), "sandbox_create", {
      size: "tiny",
    });

    expect(raw).toEqual(
      expect.objectContaining({
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining("named size only"),
          }),
        ],
      }),
    );
    expect(invalid).toEqual(
      expect.objectContaining({
        isError: true,
        content: [
          expect.objectContaining({
            text: expect.stringContaining("Invalid sandbox size"),
          }),
        ],
      }),
    );
  });
});
