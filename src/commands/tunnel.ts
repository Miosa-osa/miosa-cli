import type { Command } from "commander";
import { createServer, type Socket } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { parseSse } from "../client.js";
import type { Tunnel } from "../types.js";
import { formatBytes } from "../ui/progress.js";

// ── port-spec parser ───────────────────────────────────────────────────────
// Accepts "5432" or "5432:15432" (remote:local).

interface PortSpec {
  remotePort: number;
  localPort: number;
}

function parsePortSpec(spec: string): PortSpec {
  const parts = spec.split(":");
  if (parts.length === 1) {
    const port = parseInt(spec, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${spec}`);
    }
    return { remotePort: port, localPort: port };
  }
  if (parts.length === 2) {
    const remote = parseInt(parts[0] ?? "", 10);
    const local = parseInt(parts[1] ?? "", 10);
    if (isNaN(remote) || remote < 1 || remote > 65535) {
      throw new Error(`Invalid remote port in spec "${spec}"`);
    }
    if (isNaN(local) || local < 1 || local > 65535) {
      throw new Error(`Invalid local port in spec "${spec}"`);
    }
    return { remotePort: remote, localPort: local };
  }
  throw new Error(
    `Invalid port spec "${spec}". Use "5432" or "5432:15432" (remote:local).`,
  );
}

// ── per-port proxy stats ───────────────────────────────────────────────────

interface PortStats {
  spec: PortSpec;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
}

// ── HTTP proxy for a single TCP socket via the compute proxy ──────────────
//
// The compute proxy at {port}-{slug}.computer.miosa.ai already forwards HTTP
// requests to the VM's internal IP at the given port. Each incoming TCP
// connection is expected to speak HTTP. We relay it by acting as a transparent
// HTTP reverse proxy: buffer the incoming request, issue it to the upstream
// compute proxy URL, and pipe the response back.
//
// For WebSocket upgrade connections we handle the Upgrade header and pipe
// bidirectionally so that WS-based services (like noVNC, live-reload) work.

function proxySocket(
  socket: Socket,
  upstreamBase: string,
  apiKey: string,
  stats: PortStats,
): void {
  stats.activeConnections++;
  stats.totalConnections++;

  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    if (!socket.destroyed) socket.destroy();
  }

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  // Parse URL once — determine whether to use http or https module
  const upstreamUrl = new URL(upstreamBase);
  const isHttps = upstreamUrl.protocol === "https:";
  const agent = isHttps
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true });

  // Read the raw incoming HTTP request from the local TCP socket, then replay
  // it to the upstream compute proxy with the auth header injected.
  //
  // We collect the first chunk (which contains the HTTP request line + headers)
  // and use Node's http.IncomingParser implicitly by building a one-shot server
  // response for parsing. Instead, we create a temporary HTTP server bound to
  // a pipe so Node parses the incoming request for us.

  // Strategy: wrap the socket in a one-shot http.Server so Node parses the
  // request headers; then replay to upstream.
  const tempServer = http.createServer((req, res) => {
    const targetUrl = new URL(req.url ?? "/", upstreamBase);

    const options: http.RequestOptions | https.RequestOptions = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: req.method,
      headers: {
        ...req.headers,
        host: upstreamUrl.host,
        authorization: `Bearer ${apiKey}`,
      },
      agent,
    };

    // Handle WebSocket upgrade
    if (
      req.headers.upgrade &&
      req.headers.upgrade.toLowerCase() === "websocket"
    ) {
      // Emit upgrade via the same request — handled below
      return;
    }

    const proxyReq = (isHttps ? https : http).request(
      options as https.RequestOptions,
      (proxyRes) => {
        stats.bytesOut += 1;
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.on("data", (chunk: Buffer) => {
          stats.bytesOut += chunk.length;
        });
        proxyRes.pipe(res, { end: true });
      },
    );

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Bad Gateway");
      }
      cleanup();
    });

    req.on("data", (chunk: Buffer) => {
      stats.bytesIn += chunk.length;
    });

    req.pipe(proxyReq, { end: true });
  });

  // Handle WebSocket upgrades through the temp server
  tempServer.on(
    "upgrade",
    (req: http.IncomingMessage, clientSocket: Socket, head: Buffer) => {
      const options: http.RequestOptions | https.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: req.url ?? "/",
        method: "GET",
        headers: {
          ...req.headers,
          host: upstreamUrl.host,
          authorization: `Bearer ${apiKey}`,
        },
        agent,
      };

      const proxyReq = (isHttps ? https : http).request(
        options as https.RequestOptions,
      );

      proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
        clientSocket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n\r\n",
        );
        if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
        stats.bytesIn += head.length;

        proxySocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => proxySocket.destroy());
      });

      proxyReq.on("error", () => clientSocket.destroy());
      if (head && head.length) proxyReq.write(head);
      proxyReq.end();
    },
  );

  // Attach the raw socket to the temp HTTP server so Node parses the request
  tempServer.emit("connection", socket);
}

// ── forward subcommand implementation ─────────────────────────────────────

// Shape of the computer object returned by GET /api/v1/computers/:id
interface ComputerRecord {
  id: string;
  slug?: string | null;
  name?: string | null;
  state?: string;
}

// Build the compute proxy base URL for a given port and computer slug.
//
// The compute proxy router handles the pattern:
//   {port}-{slug}.computer.miosa.ai  →  VM internal IP : <port>  (HTTP)
//
// This is the only working path for computer port forwarding right now.
// The proxy speaks HTTP only — connections that arrive as raw TCP (postgres,
// redis, etc.) will not traverse it correctly.  HTTP and WebSocket-based
// services (web apps, REST APIs, live-reload) work fine.
function buildProxyBaseUrl(slug: string, remotePort: number): string {
  return `https://${remotePort}-${slug}.computer.miosa.ai`;
}

async function runForward(
  computerId: string,
  portSpecs: PortSpec[],
  opts: { json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const client = new MiosaClient(config);
  const apiKey = config.api_key;

  if (!apiKey) {
    throw new Error("Not authenticated. Run: miosa auth login");
  }

  // Resolve the computer record to get its slug, which drives the proxy URL.
  const spinner = spin(`Resolving computer ${computerId}...`);
  const record = await client.apiGet<{ data: ComputerRecord }>(
    `/api/v1/computers/${encodeURIComponent(computerId)}`,
  );
  spinner.stop();

  const computer = record.data;
  const slug = computer.slug ?? computer.id;

  if (!slug) {
    throw new Error(
      `Could not determine slug for computer ${computerId}. Ensure the computer exists and is running.`,
    );
  }

  const allStats: PortStats[] = portSpecs.map((spec) => ({
    spec,
    activeConnections: 0,
    totalConnections: 0,
    bytesIn: 0,
    bytesOut: 0,
  }));

  const servers = await Promise.all(
    portSpecs.map(async (spec, idx) => {
      const stats = allStats[idx]!;
      // Build upstream URL: https://{port}-{slug}.computer.miosa.ai
      // The compute proxy routes this to the VM's internal IP at `spec.remotePort`.
      const upstreamBase = buildProxyBaseUrl(slug, spec.remotePort);

      return new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer((socket) => {
          proxySocket(socket, upstreamBase, String(apiKey), stats);
        });

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            reject(
              new Error(
                `Port ${spec.localPort} is already in use. Use "remote:local" syntax to choose a different local port.`,
              ),
            );
          } else {
            reject(err);
          }
        });

        server.listen(spec.localPort, "127.0.0.1", () => {
          resolve(server);
        });
      });
    }),
  );

  // Print the tunnel table
  if (opts.json) {
    console.log(
      JSON.stringify(
        portSpecs.map((s) => ({
          computer_id: computerId,
          remote_port: s.remotePort,
          local_port: s.localPort,
          local_url: `localhost:${s.localPort}`,
        })),
        null,
        2,
      ),
    );
  } else {
    if (portSpecs.length === 1) {
      const spec = portSpecs[0]!;
      console.log(
        `${chalk.green("Tunneling")} ${chalk.cyan(computerId)}:${chalk.bold(String(spec.remotePort))} ${chalk.dim("→")} ${chalk.cyan(`localhost:${spec.localPort}`)}`,
      );
    } else {
      console.log(`${chalk.green("Tunneling:")}`);
      for (const spec of portSpecs) {
        console.log(
          `  ${chalk.cyan(computerId)}:${chalk.bold(String(spec.remotePort))} ${chalk.dim("→")} ${chalk.cyan(`localhost:${spec.localPort}`)}`,
        );
      }
    }
    console.log(chalk.dim("Press Ctrl+C to close\n"));
  }

  // Stats ticker — print connection/byte counts every 5s when there is activity
  const ticker = setInterval(() => {
    if (opts.json) return;
    const active = allStats.reduce((n, s) => n + s.activeConnections, 0);
    if (active === 0) return;
    const totalIn = allStats.reduce((n, s) => n + s.bytesIn, 0);
    const totalOut = allStats.reduce((n, s) => n + s.bytesOut, 0);
    process.stderr.write(
      chalk.dim(
        `\r[${new Date().toLocaleTimeString()}] connections: ${active}  ↑ ${formatBytes(totalIn)}  ↓ ${formatBytes(totalOut)}  `,
      ),
    );
  }, 5_000);

  // Graceful shutdown — resolves the wait promise so the async function
  // returns cleanly. process.exit(0) is called after so the real CLI exits,
  // but in tests (where process.exit is mocked) the promise still settles.
  let resolveWait!: () => void;
  const waitForSignal = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  async function shutdown(): Promise<void> {
    clearInterval(ticker);
    process.stderr.write("\n");
    if (!opts.json) {
      process.stdout.write(chalk.dim("\nClosing tunnels...\n"));
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    resolveWait();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await waitForSignal;
}

// ── register ───────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const tunnelCmd = program
    .command("tunnel")
    .alias("tunnels")
    .description("Manage tunnels and port forwarding");

  // ── open (public host tunnel) ────────────────────────────────────────────

  tunnelCmd
    .command("open <host>")
    .description("Open a public tunnel on a host port")
    .requiredOption("--port <n>", "Local port on the host to expose", parseInt)
    .option("--name <slug>", "Optional tunnel name/slug")
    .option("--watch", "Stay open and stream live tunnel events")
    .action(
      async (
        hostArg: string,
        opts: { port: number; name?: string; watch?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);

          const spinner = spin(`Resolving host ${hostArg}...`);
          const host = await client.getHost(hostArg);
          spinner.text = "Opening tunnel...";

          const tunnel = await client.createTunnel(host.id, {
            port: opts.port,
            name: opts.name,
          });

          spinner.succeed(`Tunnel open: ${chalk.cyan(tunnel.public_url)}`);
          console.log(
            chalk.dim(`  Slug: ${tunnel.slug}  Port: ${tunnel.port}`),
          );

          if (opts.watch) {
            console.log(chalk.dim("\nWatching for events (Ctrl+C to stop)..."));
            const res = await client.watchEvents(host.id);
            for await (const event of parseSse(res.body)) {
              if (event.type === "heartbeat") continue;
              const ts = new Date().toLocaleTimeString();
              console.log(
                `${chalk.dim(ts)}  ${chalk.yellow(event.type)}  ${formatEvent(event)}`,
              );
            }
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── list ─────────────────────────────────────────────────────────────────

  tunnelCmd
    .command("list <host>")
    .alias("ls")
    .description("List tunnels on a host")
    .option("--json", "Output as JSON")
    .action(async (hostArg: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const host = await client.getHost(hostArg);
        const tunnels = await client.listTunnels(host.id);

        if (opts.json) {
          console.log(JSON.stringify(tunnels, null, 2));
          return;
        }

        if (tunnels.length === 0) {
          console.log(chalk.dim("No tunnels."));
          return;
        }

        renderTable<Tunnel>(tunnels, [
          { header: "SLUG", key: "slug", width: 20 },
          { header: "PORT", key: (t) => String(t.port), width: 6 },
          { header: "PUBLIC URL", key: "public_url", width: 40 },
          { header: "STATE", key: "state", width: 8 },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  // ── close ─────────────────────────────────────────────────────────────────

  tunnelCmd
    .command("close <host> <slug>")
    .description("Close (revoke) a tunnel")
    .action(async (hostArg: string, slug: string) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const host = await client.getHost(hostArg);
        const spinner = spin(`Closing tunnel ${slug}...`);
        await client.closeTunnel(
          host.id,
          slug as import("../types.js").TunnelSlug,
        );
        spinner.succeed(`Tunnel ${slug} closed.`);
      } catch (err) {
        handleError(err);
      }
    });

  // ── forward (local TCP → Computer port via API proxy) ────────────────────

  tunnelCmd
    .command("forward <computer-id> [ports...]")
    .alias("proxy")
    .description(
      [
        "Forward local port(s) to a Computer via the compute proxy.",
        "",
        "Traffic is routed through https://{port}-{slug}.computer.miosa.ai,",
        "which the compute proxy forwards to the VM's internal port.",
        "HTTP and WebSocket services work; raw TCP protocols (postgres, redis)",
        "require the service to speak HTTP or use a separate relay.",
        "",
        "Ports can be specified as:",
        "  8080          forward localhost:8080 → computer:8080",
        "  8080:3000     forward localhost:3000 → computer:8080",
        "",
        "Examples:",
        "  miosa tunnel forward my-box 8080",
        "  miosa tunnel forward my-box 8080 3000",
        "  miosa tunnel forward my-box 8080:3000",
      ].join("\n"),
    )
    .option(
      "--local-port <port>",
      "Local port (only when forwarding a single remote port)",
      parseInt,
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        computerId: string,
        rawPorts: string[],
        opts: { localPort?: number; json?: boolean },
      ) => {
        try {
          if (rawPorts.length === 0) {
            console.error(
              chalk.red(
                "Provide at least one port. E.g.: miosa tunnel forward my-box 5432",
              ),
            );
            process.exit(1);
          }

          let portSpecs: PortSpec[];

          if (rawPorts.length === 1 && opts.localPort !== undefined) {
            // --local-port override for single-port case
            const remote = parseInt(rawPorts[0] ?? "", 10);
            if (isNaN(remote) || remote < 1 || remote > 65535) {
              throw new Error(`Invalid remote port: ${rawPorts[0]}`);
            }
            portSpecs = [{ remotePort: remote, localPort: opts.localPort }];
          } else {
            portSpecs = rawPorts.map(parsePortSpec);
          }

          await runForward(computerId, portSpecs, opts);
        } catch (err) {
          handleError(err);
        }
      },
    );
}

// ── helpers ────────────────────────────────────────────────────────────────

function formatEvent(event: import("../types.js").SseEvent): string {
  switch (event.type) {
    case "stdout":
    case "stderr":
      return event.data.trim();
    case "error":
      return chalk.red(event.message);
    case "thought":
      return chalk.italic(event.content);
    case "tool_call":
      return `${event.tool}(${JSON.stringify(event.input)})`;
    case "tool_result":
      return `${event.tool} → ${JSON.stringify(event.output)}`;
    case "exit":
      return `exit ${event.exit_code}`;
    case "done":
      return "done";
    default:
      return "";
  }
}
