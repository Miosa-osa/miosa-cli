/**
 * Layered connectivity diagnosis.
 *
 * Why this exists: `doctor` used to collapse everything between the CLI and the
 * API into one boolean, "API reachable". When a customer's DNS was failing, the
 * CLI reported the endpoint and an active auth session while every request was
 * dying at `getaddrinfo ENOTFOUND` - so the one question the command exists to
 * answer, "which layer is broken", could not be answered by it.
 *
 * Each layer is probed separately and in order. A layer that could not run
 * because an earlier one failed reports `unknown`, NEVER `fail` - "we could not
 * check this" and "this is broken" are different answers and the difference is
 * the entire diagnostic value.
 */

import { lookup as dnsLookup, resolve4, resolve6 } from "node:dns/promises";
import { getServers, Resolver } from "node:dns";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { request } from "undici";

/** `unknown` = not determined, because a prerequisite layer failed first. */
export type LayerState = "ok" | "fail" | "unknown";

export interface LayerResult {
  /** Stable machine-readable id. Safe to branch on in scripts. */
  layer: "dns" | "tcp" | "tls" | "http" | "auth";
  /** Human label. */
  name: string;
  state: LayerState;
  /** Human-readable outcome. */
  detail: string;
  /** Round-trip for this layer alone, when measured. */
  latencyMs?: number;
  /** Underlying error code, e.g. ENOTFOUND, ECONNREFUSED, CERT_HAS_EXPIRED. */
  errorCode?: string;
  /** What to do about it. Present only when state is "fail". */
  fix?: string;
  /** Why this layer was not determined. Present only when state is "unknown". */
  skippedBecause?: string;
}

export interface Diagnosis {
  /** Which DNS servers answered, and whether a configured override was applied. */
  resolver: { applied: boolean; servers: string[]; error?: string };
  endpoint: string;
  host: string;
  port: number;
  protocol: "http:" | "https:";
  layers: LayerResult[];
  /** The FIRST failing layer - the one to act on. Null when everything passed. */
  firstFailure: LayerResult["layer"] | null;
  /** One sentence naming the fault, or confirming the path is clean. */
  summary: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

function errCode(e: unknown): string | undefined {
  if (e && typeof e === "object") {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}


/**
 * Build a resolver for explicit DNS servers.
 *
 * For restricted, split-horizon or corporate networks where the machine's
 * default resolver cannot resolve the API endpoint - the situation Ross's
 * `getaddrinfo ENOTFOUND` turned out to be. Without this the only remedy was
 * changing OS-level DNS, which a user often cannot do on a managed laptop.
 *
 * Two things about Node make the naive version silently useless, and both were
 * caught by checking the output rather than trusting it:
 *
 *   1. `dnsPromises.setServers()` and `dns.getServers()` read DIFFERENT
 *      resolver state, so setting one and reading the other reports success
 *      while nothing changed. This uses one explicit `Resolver` instance and
 *      reads back from that same instance.
 *   2. `dns.lookup()` goes through the OS resolver (getaddrinfo) and IGNORES
 *      configured servers entirely. Only `resolve*()` honours them. So when an
 *      override is configured the probe must resolve via `resolve4/resolve6`,
 *      not `lookup`.
 */
export interface ResolverChoice {
  applied: boolean;
  servers: string[];
  error?: string;
  resolver?: Resolver;
}

export function applyResolver(servers: string | null | undefined): ResolverChoice {
  if (!servers || !servers.trim()) {
    return { applied: false, servers: getServers() };
  }

  const list = servers
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (list.length === 0) return { applied: false, servers: getServers() };

  try {
    const resolver = new Resolver();
    // Throws on a malformed address. Failing loudly is right: silently falling
    // back to the OS resolver would make a configured override look like it
    // worked while the fault it was meant to route around persisted.
    resolver.setServers(list);
    return { applied: true, servers: resolver.getServers(), resolver };
  } catch (e) {
    return { applied: false, servers: getServers(), error: errMessage(e) };
  }
}

async function probeDns(host: string, choice: ResolverChoice): Promise<LayerResult> {
  // A literal IP needs no resolution; saying "ok" here would imply we tested
  // something we did not.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return {
      layer: "dns",
      name: "DNS resolution",
      state: "ok",
      detail: `${host} is a literal address, no lookup needed`,
    };
  }

  const start = Date.now();
  try {
    // With an override, resolve THROUGH IT - dns.lookup() would silently use
    // the OS resolver and the override would do nothing.
    let address: string;
    let family: number;

    if (choice.applied && choice.resolver) {
      const v4 = await new Promise<string[]>((res, rej) =>
        choice.resolver!.resolve4(host, (e, a) => (e ? rej(e) : res(a))),
      ).catch(() => [] as string[]);
      const v6 =
        v4.length > 0
          ? []
          : await new Promise<string[]>((res, rej) =>
              choice.resolver!.resolve6(host, (e, a) => (e ? rej(e) : res(a))),
            ).catch(() => [] as string[]);

      if (v4.length === 0 && v6.length === 0) {
        throw Object.assign(new Error(`no records from ${choice.servers.join(", ")}`), {
          code: "ENOTFOUND",
        });
      }
      address = v4[0] ?? v6[0]!;
      family = v4.length > 0 ? 4 : 6;
    } else {
      const looked = await dnsLookup(host);
      address = looked.address;
      family = looked.family;
    }

    const latencyMs = Date.now() - start;

    // Also report every address, so split-horizon or stale-cache faults are
    // visible rather than hidden behind whichever one lookup() happened to pick.
    let all: string[] = [];
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      if (v4.status === "fulfilled") all = all.concat(v4.value);
      if (v6.status === "fulfilled") all = all.concat(v6.value);
    } catch {
      // Best effort - lookup() already succeeded, which is the load-bearing part.
    }

    const extra = all.length > 1 ? ` (${all.length} addresses: ${all.join(", ")})` : "";
    return {
      layer: "dns",
      name: "DNS resolution",
      state: "ok",
      detail:
        `${host} -> ${address} (IPv${family})${extra}` +
        (choice.applied ? ` via ${choice.servers.join(", ")}` : ""),
      latencyMs,
    };
  } catch (e) {
    const code = errCode(e);
    return {
      layer: "dns",
      name: "DNS resolution",
      state: "fail",
      detail: `cannot resolve ${host}: ${errMessage(e)}`,
      errorCode: code,
      fix:
        code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? `Your resolver cannot resolve ${host}. This is a local network or DNS problem, not a MIOSA outage - check your DNS settings, VPN, or corporate resolver. On a restricted network, point the CLI at a reachable endpoint: miosa config set api_url <url>`
          : `DNS lookup for ${host} failed. Check your resolver configuration.`,
    };
  }
}

function probeTcp(host: string, port: number): Promise<LayerResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = tcpConnect({ host, port });
    let settled = false;

    const finish = (r: LayerResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };

    socket.setTimeout(DEFAULT_TIMEOUT_MS);
    socket.once("connect", () =>
      finish({
        layer: "tcp",
        name: "TCP connect",
        state: "ok",
        detail: `connected to ${host}:${port}`,
        latencyMs: Date.now() - start,
      }),
    );
    socket.once("timeout", () =>
      finish({
        layer: "tcp",
        name: "TCP connect",
        state: "fail",
        detail: `timed out connecting to ${host}:${port} after ${DEFAULT_TIMEOUT_MS}ms`,
        errorCode: "ETIMEDOUT",
        fix: "The address resolves but nothing accepted the connection in time. A firewall or proxy is the usual cause.",
      }),
    );
    socket.once("error", (e) =>
      finish({
        layer: "tcp",
        name: "TCP connect",
        state: "fail",
        detail: `cannot connect to ${host}:${port}: ${errMessage(e)}`,
        errorCode: errCode(e),
        fix:
          errCode(e) === "ECONNREFUSED"
            ? `Nothing is listening on ${host}:${port}. If this is a local endpoint, check the service is running.`
            : "The address resolves but the connection failed. Check firewall and proxy rules.",
      }),
    );
  });
}

function probeTls(host: string, port: number): Promise<LayerResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    // `rejectUnauthorized` stays ON: a diagnosis that passes on an invalid
    // certificate would hide the exact fault it exists to find.
    const socket = tlsConnect({ host, port, servername: host });
    let settled = false;

    const finish = (r: LayerResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };

    socket.setTimeout(DEFAULT_TIMEOUT_MS);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const proto = socket.getProtocol() ?? "unknown";
      const expiry = cert?.valid_to ? `, expires ${cert.valid_to}` : "";
      const issuer =
        cert && typeof cert.issuer === "object" && cert.issuer !== null
          ? ((cert.issuer as { O?: string }).O ?? "unknown issuer")
          : "unknown issuer";
      finish({
        layer: "tls",
        name: "TLS handshake",
        state: "ok",
        detail: `${proto} verified (${issuer}${expiry})`,
        latencyMs: Date.now() - start,
      });
    });
    socket.once("timeout", () =>
      finish({
        layer: "tls",
        name: "TLS handshake",
        state: "fail",
        detail: `TLS handshake to ${host}:${port} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        errorCode: "ETIMEDOUT",
        fix: "TCP connected but TLS never completed. A TLS-intercepting proxy is the usual cause.",
      }),
    );
    socket.once("error", (e) => {
      const code = errCode(e);
      finish({
        layer: "tls",
        name: "TLS handshake",
        state: "fail",
        detail: `TLS handshake failed: ${errMessage(e)}`,
        errorCode: code,
        fix:
          code === "CERT_HAS_EXPIRED"
            ? "The server certificate has expired."
            : code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
                code === "SELF_SIGNED_CERT_IN_CHAIN" ||
                code === "DEPTH_ZERO_SELF_SIGNED_CERT"
              ? "The certificate chain does not verify. On a corporate network this usually means a TLS-intercepting proxy whose root CA your machine does not trust."
              : "TCP connected but TLS failed. Check for a TLS-intercepting proxy.",
      });
    });
  });
}

async function probeHttp(endpoint: string): Promise<LayerResult> {
  const url = `${endpoint.replace(/\/$/, "")}/health`;
  const start = Date.now();
  try {
    const res = await request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      bodyTimeout: DEFAULT_TIMEOUT_MS,
      headersTimeout: DEFAULT_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - start;
    const requestId =
      (res.headers["x-request-id"] as string | undefined) ??
      (res.headers["request-id"] as string | undefined);
    await res.body.dump();

    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return {
      layer: "http",
      name: "API health",
      state: ok ? "ok" : "fail",
      detail: `GET /health -> ${res.statusCode}${requestId ? ` (request_id ${requestId})` : ""}`,
      latencyMs,
      errorCode: ok ? undefined : `HTTP_${res.statusCode}`,
      fix: ok
        ? undefined
        : `The endpoint is reachable but /health answered ${res.statusCode}. This is a MIOSA-side fault, not your network - quote the request id when reporting it.`,
    };
  } catch (e) {
    return {
      layer: "http",
      name: "API health",
      state: "fail",
      detail: `GET ${url} failed: ${errMessage(e)}`,
      errorCode: errCode(e),
      fix: "The transport layers passed but the HTTP request failed. Check for a proxy that terminates requests.",
    };
  }
}

function unknownLayer(
  layer: LayerResult["layer"],
  name: string,
  because: string,
): LayerResult {
  return {
    layer,
    name,
    state: "unknown",
    detail: "not determined",
    skippedBecause: because,
  };
}

/**
 * Probe every layer between this machine and the API, in order.
 *
 * `authProbe` is injected so this module stays free of client and config
 * imports: pass a thunk that performs an authenticated call and resolves to a
 * short description of the identity it proved.
 */
export async function diagnose(
  endpoint: string,
  authProbe?: () => Promise<string>,
  dnsServers?: string | null,
): Promise<Diagnosis> {
  const resolver = applyResolver(dnsServers);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    const bad: LayerResult = {
      layer: "dns",
      name: "DNS resolution",
      state: "fail",
      detail: `endpoint is not a valid URL: ${endpoint}`,
      errorCode: "ERR_INVALID_URL",
      fix: "Set a valid endpoint: miosa config set api_url <url>",
    };
    return {
      resolver: { applied: false, servers: [] },
      endpoint,
      host: endpoint,
      port: 0,
      protocol: "https:",
      layers: [
        bad,
        unknownLayer("tcp", "TCP connect", "endpoint is not a valid URL"),
        unknownLayer("tls", "TLS handshake", "endpoint is not a valid URL"),
        unknownLayer("http", "API health", "endpoint is not a valid URL"),
        unknownLayer("auth", "Authentication", "endpoint is not a valid URL"),
      ],
      firstFailure: "dns",
      summary: `The configured endpoint is not a valid URL: ${endpoint}`,
    };
  }

  const protocol = url.protocol === "http:" ? "http:" : "https:";
  const host = url.hostname;
  const port = url.port ? Number(url.port) : protocol === "https:" ? 443 : 80;

  const layers: LayerResult[] = [];

  const dns = await probeDns(host, resolver);
  layers.push(dns);

  if (dns.state !== "ok") {
    layers.push(unknownLayer("tcp", "TCP connect", "DNS did not resolve"));
    layers.push(unknownLayer("tls", "TLS handshake", "DNS did not resolve"));
    layers.push(unknownLayer("http", "API health", "DNS did not resolve"));
    layers.push(unknownLayer("auth", "Authentication", "DNS did not resolve"));
    return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
  }

  const tcp = await probeTcp(host, port);
  layers.push(tcp);

  if (tcp.state !== "ok") {
    layers.push(unknownLayer("tls", "TLS handshake", "TCP did not connect"));
    layers.push(unknownLayer("http", "API health", "TCP did not connect"));
    layers.push(unknownLayer("auth", "Authentication", "TCP did not connect"));
    return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
  }

  if (protocol === "https:") {
    const tls = await probeTls(host, port);
    layers.push(tls);
    if (tls.state !== "ok") {
      layers.push(unknownLayer("http", "API health", "TLS handshake failed"));
      layers.push(unknownLayer("auth", "Authentication", "TLS handshake failed"));
      return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
    }
  } else {
    layers.push({
      layer: "tls",
      name: "TLS handshake",
      state: "ok",
      detail: "endpoint is plain http, no TLS to verify",
    });
  }

  const http = await probeHttp(endpoint);
  layers.push(http);

  if (http.state !== "ok") {
    layers.push(unknownLayer("auth", "Authentication", "API health check failed"));
    return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
  }

  if (!authProbe) {
    layers.push(unknownLayer("auth", "Authentication", "no credentials configured"));
    return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
  }

  const start = Date.now();
  try {
    const identity = await authProbe();
    layers.push({
      layer: "auth",
      name: "Authentication",
      state: "ok",
      detail: identity,
      latencyMs: Date.now() - start,
    });
  } catch (e) {
    layers.push({
      layer: "auth",
      name: "Authentication",
      state: "fail",
      detail: `credentials rejected: ${errMessage(e)}`,
      errorCode: errCode(e),
      fix: "The API is reachable and healthy, so this is a credential problem, not a network one. Run: miosa login",
    });
  }

  return finalize(endpoint, host, port, protocol, layers, publicResolver(resolver));
}

// The Resolver instance itself must never reach the JSON output.
function publicResolver(c: ResolverChoice): {
  applied: boolean;
  servers: string[];
  error?: string;
} {
  return c.error
    ? { applied: c.applied, servers: c.servers, error: c.error }
    : { applied: c.applied, servers: c.servers };
}

function finalize(
  endpoint: string,
  host: string,
  port: number,
  protocol: "http:" | "https:",
  layers: LayerResult[],
  resolver: { applied: boolean; servers: string[]; error?: string } = {
    applied: false,
    servers: [],
  },
): Diagnosis {
  const failed = layers.find((l) => l.state === "fail");
  const summary = failed
    ? `${failed.name} failed: ${failed.detail}. Everything below it is UNVERIFIED, not healthy.`
    : `All layers healthy: DNS, TCP, TLS, /health, and credentials for ${host}.`;
  return {
    resolver,
    endpoint,
    host,
    port,
    protocol,
    layers,
    firstFailure: failed ? failed.layer : null,
    summary,
  };
}
