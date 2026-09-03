import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleError } from "../../src/commands/util.js";
import { ApiResponseError, ServerError } from "../../src/errors.js";
import { EXIT_SERVER_ERROR, EXIT_USER_ERROR } from "../../src/types.js";

function errorOutput(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.join(" "))
    .join("\n");
}

function jsonOutput(): { ok: boolean; error: Record<string, unknown> } {
  const call = vi.mocked(console.log).mock.calls[0];
  return JSON.parse(String(call?.[0]));
}

describe("handleError", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env["MIOSA_JSON"];
    delete process.env["MIOSA_DEBUG"];
  });

  afterEach(() => {
    delete process.env["MIOSA_JSON"];
    delete process.env["MIOSA_DEBUG"];
    vi.restoreAllMocks();
  });

  describe("normal (non-debug, non-json) output", () => {
    it("should print code, message, and details when a coded 422 has structured details", () => {
      handleError(
        new ApiResponseError(
          "SANDBOX_NAME_RESERVED",
          "HTTP 422",
          EXIT_USER_ERROR,
          false,
          undefined,
          { reason: "destroyed sandbox name remains reserved" },
          "req_abc123",
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Error: HTTP 422");
      expect(out).toContain("Code: SANDBOX_NAME_RESERVED");
      expect(out).toContain("Details:");
      expect(out).toContain(
        '"reason": "destroyed sandbox name remains reserved"',
      );
      // request id / raw response stay behind --debug
      expect(out).not.toContain("req_abc123");
      expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    });

    it("should print scalar details inline when a coded 422 has string details", () => {
      handleError(
        new ApiResponseError(
          "NAME_TAKEN",
          "Validation error",
          EXIT_USER_ERROR,
          false,
          undefined,
          "name already in use",
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Details: name already in use");
    });

    it("should print code and message without a details line when a 422 has message only", () => {
      handleError(
        new ApiResponseError(
          "VALIDATION_FAILED",
          "Validation error: name is required",
          EXIT_USER_ERROR,
          false,
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Error: Validation error: name is required");
      expect(out).toContain("Code: VALIDATION_FAILED");
      expect(out).not.toContain("Details:");
      expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    });

    it("should keep 5xx details behind --debug", () => {
      handleError(
        new ServerError(
          "Server error (500): HTTP 500",
          500,
          "<html>internal error</html>",
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Error: Server error (500): HTTP 500");
      expect(out).not.toContain("Details:");
      expect(process.exit).toHaveBeenCalledWith(EXIT_SERVER_ERROR);
    });

    it("should keep coded 5xx details behind --debug", () => {
      handleError(
        new ApiResponseError(
          "UPSTREAM_UNAVAILABLE",
          "HTTP 503",
          EXIT_SERVER_ERROR,
          true,
          undefined,
          { upstream: "compute-01" },
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Code: UPSTREAM_UNAVAILABLE");
      expect(out).not.toContain("Details:");
    });

    it("should print 5xx details when --debug is set", () => {
      process.env["MIOSA_DEBUG"] = "1";
      handleError(
        new ApiResponseError(
          "UPSTREAM_UNAVAILABLE",
          "HTTP 503",
          EXIT_SERVER_ERROR,
          true,
          undefined,
          { upstream: "compute-01" },
          "req_dbg",
        ),
      );

      const out = errorOutput();
      expect(out).toContain("Details:");
      expect(out).toContain('"upstream": "compute-01"');
      expect(out).toContain("Request ID: req_dbg");
    });

    it("should not print details twice when --debug is set on a 4xx error", () => {
      process.env["MIOSA_DEBUG"] = "1";
      handleError(
        new ApiResponseError(
          "SANDBOX_NAME_RESERVED",
          "HTTP 422",
          EXIT_USER_ERROR,
          false,
          undefined,
          { reason: "reserved" },
        ),
      );

      const out = errorOutput();
      expect(out.match(/Details:/g)).toHaveLength(1);
    });
  });

  describe("json output", () => {
    it("should include code and details for a coded 4xx error without --debug", () => {
      process.env["MIOSA_JSON"] = "1";
      handleError(
        new ApiResponseError(
          "SANDBOX_NAME_RESERVED",
          "HTTP 422",
          EXIT_USER_ERROR,
          false,
          undefined,
          { reason: "destroyed sandbox name remains reserved" },
          "req_abc123",
        ),
      );

      const { ok, error } = jsonOutput();
      expect(ok).toBe(false);
      expect(error["code"]).toBe("SANDBOX_NAME_RESERVED");
      expect(error["message"]).toBe("HTTP 422");
      expect(error["details"]).toEqual({
        reason: "destroyed sandbox name remains reserved",
      });
      expect(error["request_id"]).toBe("req_abc123");
      expect(process.exit).toHaveBeenCalledWith(EXIT_USER_ERROR);
    });

    it("should keep 5xx details debug-only", () => {
      process.env["MIOSA_JSON"] = "1";
      handleError(
        new ApiResponseError(
          "UPSTREAM_UNAVAILABLE",
          "HTTP 503",
          EXIT_SERVER_ERROR,
          true,
          undefined,
          { upstream: "compute-01" },
        ),
      );

      const { error } = jsonOutput();
      expect(error["details"]).toBeUndefined();
    });

    it("marks uncoded 503s as retryable and preserves their request ID", () => {
      process.env["MIOSA_JSON"] = "1";
      handleError(new ServerError("HTTP 503", 503, undefined, "req_503"));

      const { error } = jsonOutput();
      expect(error["retryable"]).toBe(true);
      expect(error["request_id"]).toBe("req_503");
    });

    it("does not mark an uncoded 501 as retryable", () => {
      process.env["MIOSA_JSON"] = "1";
      handleError(new ServerError("HTTP 501", 501));

      const { error } = jsonOutput();
      expect(error["retryable"]).toBe(false);
    });
  });
});
