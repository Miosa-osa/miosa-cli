import type { Command } from "commander";
import { createServer, type Socket } from "node:net";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { parseSse } from "../client.js";
import type { Tunnel } from "../types.js";
import { WebSocket } from "ws";
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

// ── WebSocket proxy for a single TCP socket ────────────────────────────────

function proxySocket(
  socket: Socket,
  wsUrl: string,
  apiKey: string,
  stats: PortStats,
): void {
  stats.activeConnections++;
  stats.totalConnections++;

  let ws: WebSocket | null = null;
  let reconnecting = false;
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    socket.destroy();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  function connect(): void {
    if (closed) return;

    ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "@miosa/cli/0.1.0",
      },
    });

    ws.on("open", () => {
      reconnecting = false;
      // Resume the TCP socket once WS is ready
      socket.resume();
    });

    ws.on("message", (data: Buffer) => {
      stats.bytesOut += data.length;
      if (!socket.destroyed) {
        socket.write(data);
      }
    });

    ws.on("close", () => {
      if (!closed && !reconnecting && !socket.destroyed) {
        // Attempt a single reconnect after a brief back-off
        reconnecting = true;
        socket.pause();
        setTimeout(() => {
          if (!closed) connect();
        }, 1_000);
      } else {
        cleanup();
      }
    });

    ws.on("error", () => {
      cleanup();
    });
  }

  // Pause reads until WebSocket is open
  socket.pause();

  socket.on("data", (chunk: Buffer) => {
    stats.bytesIn += chunk.length;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  });

  socket.on("close", cleanup);
  socket.on("error", cleanup);

  connect();
}

// ── forward subcommand implementation ─────────────────────────────────────

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

  // Verify the computer exists before opening any sockets
  const spinner = spin(`Resolving computer ${computerId}...`);
  await client.apiGet<unknown>(
    `/api/v1/computers/${encodeURIComponent(computerId)}`,
  );
  spinner.stop();

  const endpoint = config.endpoint.replace(/\/$/, "");
  // Convert http(s) → ws(s) for WebSocket URL
  const wsBase = endpoint.replace(/^https/, "wss").replace(/^http/, "ws");

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
      const wsUrl = `${wsBase}/api/v1/computers/${encodeURIComponent(computerId)}/tunnel/${spec.remotePort}`;

      return new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
        const server = createServer((socket) => {
          proxySocket(socket, wsUrl, String(apiKey), stats);
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
        "Forward local TCP port(s) to a Computer's internal ports.",
        "",
        "Ports can be specified as:",
        "  5432          forward localhost:5432 → computer:5432",
        "  5432:15432    forward localhost:15432 → computer:5432",
        "",
        "Examples:",
        "  miosa tunnel forward my-box 5432",
        "  miosa tunnel forward my-box 5432 6379 8080",
        "  miosa tunnel forward my-box 5432:15432",
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
