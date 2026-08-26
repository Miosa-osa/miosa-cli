/**
 * Endpoint resolution and transport-failure diagnosis.
 *
 * A CLI that cannot resolve its API host must say which host it tried, where
 * that host came from, and how to change it. The bare
 * `Network error: getaddrinfo ENOTFOUND <host>` it printed before named the
 * host but nothing else, leaving no way to tell a typo in `MIOSA_ENDPOINT`
 * apart from a typo in `~/.miosa/config.json` apart from real DNS trouble
 * (2026-08-26 live customer call).
 */

import { getConfigPath } from "./config.js";
import { NetworkError, UserError } from "./errors.js";

export const DEFAULT_ENDPOINT = "https://api.miosa.ai";

export type EndpointSource =
  "MIOSA_ENDPOINT" | "config-file" | "built-in-default";

export interface EndpointOrigin {
  readonly source: EndpointSource;
  /** Human description of where the value lives, and how to change it. */
  readonly where: string;
  readonly fix: string;
}

/**
 * Work out where the endpoint currently in use came from. Mirrors the
 * precedence in `loadConfig`: MIOSA_ENDPOINT, then the config file, then the
 * built-in default.
 */
export function endpointOrigin(endpoint: string): EndpointOrigin {
  const fromEnv = process.env["MIOSA_ENDPOINT"];
  const normalized = endpoint.replace(/\/$/, "");

  if (fromEnv && fromEnv.replace(/\/$/, "") === normalized) {
    return {
      source: "MIOSA_ENDPOINT",
      where: "the MIOSA_ENDPOINT environment variable",
      fix: `unset MIOSA_ENDPOINT   (or: export MIOSA_ENDPOINT=${DEFAULT_ENDPOINT})`,
    };
  }

  if (normalized === DEFAULT_ENDPOINT) {
    return {
      source: "built-in-default",
      where: `the built-in default (${DEFAULT_ENDPOINT})`,
      fix: `miosa config set api_url ${DEFAULT_ENDPOINT}`,
    };
  }

  return {
    source: "config-file",
    where: `"endpoint" in ${configFileForDisplay()}`,
    fix: `miosa config set api_url ${DEFAULT_ENDPOINT}`,
  };
}

/**
 * Config file path for the message. Tolerates a stubbed config module (unit
 * tests replace it wholesale) by degrading to the documented location rather
 * than crashing the error path that is meant to explain a failure.
 */
function configFileForDisplay(): string {
  return typeof getConfigPath === "function"
    ? getConfigPath()
    : "~/.miosa/config.json";
}

/**
 * Reject an endpoint that is not a usable absolute http(s) URL before any
 * request is attempted. Undici's own failure for this is the opaque
 * `TypeError: Invalid URL`, which does not even echo the offending value.
 */
export function assertUsableEndpoint(endpoint: string): void {
  const origin = endpointOrigin(endpoint);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new UserError(
      `The MIOSA API endpoint is not a valid URL: ${JSON.stringify(endpoint)}`,
      `It is set in ${origin.where}. An endpoint must include the scheme, ` +
        `for example ${DEFAULT_ENDPOINT}. Fix it with: ${origin.fix}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UserError(
      `The MIOSA API endpoint must be http or https, got ${JSON.stringify(endpoint)}`,
      `It is set in ${origin.where}. Fix it with: ${origin.fix}`,
    );
  }
}

interface CauseLike {
  readonly code?: unknown;
  readonly hostname?: unknown;
  readonly syscall?: unknown;
  readonly port?: unknown;
  readonly cause?: unknown;
}

/** Walk `err.cause` for the first entry carrying an errno-style `code`. */
function transportCause(err: unknown): CauseLike | undefined {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < 6 && current !== null && typeof current === "object";
    depth += 1
  ) {
    const candidate = current as CauseLike;
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Build a NetworkError that names the host, the config value behind it, and
 * the command that changes it.
 */
export function transportError(err: unknown, endpoint: string): NetworkError {
  const origin = endpointOrigin(endpoint);
  const raw = err instanceof Error ? err.message : String(err);
  const cause = transportCause(err);
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  let host: string;
  try {
    host = new URL(endpoint).host;
  } catch {
    host = endpoint;
  }

  const detail = ((): string => {
    switch (code) {
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return `DNS lookup failed for host "${host}" (${code}). That hostname does not resolve from this machine.`;
      case "ECONNREFUSED":
        return `The host "${host}" refused the connection (ECONNREFUSED). It resolved, but nothing is listening on that port.`;
      case "ETIMEDOUT":
      case "UND_ERR_CONNECT_TIMEOUT":
        return `Connecting to "${host}" timed out (${code}).`;
      case "CERT_HAS_EXPIRED":
      case "DEPTH_ZERO_SELF_SIGNED_CERT":
      case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
        return `TLS verification failed for "${host}" (${code}).`;
      default:
        return `Could not reach "${host}": ${raw}`;
    }
  })();

  const hint =
    code === "ENOTFOUND" || code === "EAI_AGAIN"
      ? `The endpoint ${endpoint} comes from ${origin.where}. ` +
        `Check it for a typo, then: ${origin.fix}`
      : `The endpoint ${endpoint} comes from ${origin.where}. ` +
        `Verify it with "miosa config get api_url", or change it: ${origin.fix}`;

  return new NetworkError(`Cannot reach the MIOSA API. ${detail}`, hint);
}
