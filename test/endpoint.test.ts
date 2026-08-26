import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ENDPOINT,
  assertUsableEndpoint,
  endpointOrigin,
  transportError,
} from "../src/endpoint.js";
import { UserError } from "../src/errors.js";

/** An undici-shaped transport failure: the errno lives on `err.cause`. */
function undiciFailure(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new Error("fetch failed"), { cause });
}

describe("endpointOrigin", () => {
  const saved = process.env["MIOSA_ENDPOINT"];

  beforeEach(() => {
    delete process.env["MIOSA_ENDPOINT"];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["MIOSA_ENDPOINT"];
    else process.env["MIOSA_ENDPOINT"] = saved;
  });

  it("attributes the value to MIOSA_ENDPOINT when the env var set it", () => {
    process.env["MIOSA_ENDPOINT"] = "https://api.example.test";

    const origin = endpointOrigin("https://api.example.test");

    expect(origin.source).toBe("MIOSA_ENDPOINT");
    expect(origin.where).toContain("MIOSA_ENDPOINT environment variable");
    expect(origin.fix).toContain("unset MIOSA_ENDPOINT");
  });

  it("ignores a trailing slash difference when matching the env var", () => {
    process.env["MIOSA_ENDPOINT"] = "https://api.example.test/";

    expect(endpointOrigin("https://api.example.test").source).toBe(
      "MIOSA_ENDPOINT",
    );
  });

  it("attributes the built-in default when nothing overrode it", () => {
    const origin = endpointOrigin(DEFAULT_ENDPOINT);

    expect(origin.source).toBe("built-in-default");
    expect(origin.where).toContain(DEFAULT_ENDPOINT);
  });

  it("attributes anything else to the config file, and names the key", () => {
    const origin = endpointOrigin("https://api.miosa.typo");

    expect(origin.source).toBe("config-file");
    expect(origin.where).toContain('"endpoint" in');
    expect(origin.fix).toContain("miosa config set api_url");
  });
});

describe("assertUsableEndpoint", () => {
  it("accepts http and https URLs", () => {
    expect(() => assertUsableEndpoint("https://api.miosa.ai")).not.toThrow();
    expect(() => assertUsableEndpoint("http://127.0.0.1:4000")).not.toThrow();
  });

  it("rejects a bare hostname, naming the value and where it came from", () => {
    // undici's own failure for this is "TypeError: Invalid URL", which does not
    // even echo the offending value.
    let caught: unknown;
    try {
      assertUsableEndpoint("api.miosa.ai");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UserError);
    const err = caught as UserError;
    expect(err.message).toContain('"api.miosa.ai"');
    expect(err.hint).toContain("must include the scheme");
  });

  it("rejects a non-http scheme", () => {
    expect(() => assertUsableEndpoint("ftp://api.miosa.ai")).toThrow(UserError);
  });
});

describe("transportError", () => {
  it("explains ENOTFOUND with the host, the config source and the fix", () => {
    const err = transportError(
      undiciFailure("ENOTFOUND", "getaddrinfo ENOTFOUND api.miosa.typo"),
      "https://api.miosa.typo",
    );

    expect(err.message).toContain(
      'DNS lookup failed for host "api.miosa.typo"',
    );
    expect(err.message).toContain("ENOTFOUND");
    expect(err.hint).toContain("https://api.miosa.typo");
    expect(err.hint).toContain('"endpoint" in');
    expect(err.hint).toContain("miosa config set api_url");
  });

  it("distinguishes a refused connection from an unresolvable host", () => {
    const err = transportError(
      undiciFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:59999"),
      "http://127.0.0.1:59999",
    );

    expect(err.message).toContain("refused the connection");
    expect(err.message).not.toContain("DNS lookup failed");
  });

  it("reports a connect timeout as a timeout", () => {
    const err = transportError(
      undiciFailure("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
      "https://api.miosa.ai",
    );

    expect(err.message).toContain("timed out");
  });

  it("reports a TLS verification failure as one", () => {
    const err = transportError(
      undiciFailure("CERT_HAS_EXPIRED", "certificate has expired"),
      "https://api.miosa.ai",
    );

    expect(err.message).toContain("TLS verification failed");
  });

  it("still names the endpoint for an unrecognised failure", () => {
    const err = transportError(
      new Error("something odd"),
      "https://api.miosa.ai",
    );

    expect(err.message).toContain("api.miosa.ai");
    expect(err.message).toContain("something odd");
    expect(err.hint).toContain("https://api.miosa.ai");
  });
});
