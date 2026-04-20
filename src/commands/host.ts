import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError } from "./util.js";
import type { Host, HostTelemetry } from "../types.js";

function renderHost(host: Host): void {
  const dim = chalk.dim;
  const bold = chalk.bold;

  console.log();
  console.log(`  ${bold("ID")}           ${host.id}`);
  console.log(`  ${bold("Name")}         ${host.name}`);
  console.log(`  ${bold("State")}        ${colorState(host.state)}`);
  console.log(`  ${bold("OS")}           ${host.os ?? dim("unknown")}`);
  console.log(`  ${bold("Platform")}     ${host.platform ?? dim("unknown")}`);
  console.log(`  ${bold("Arch")}         ${host.arch ?? dim("unknown")}`);
  console.log(`  ${bold("Hostname")}     ${host.hostname ?? dim("unknown")}`);
  console.log(
    `  ${bold("Last seen")}    ${host.last_heartbeat ? new Date(host.last_heartbeat).toLocaleString() : dim("never")}`,
  );
  console.log(
    `  ${bold("Created")}      ${new Date(host.inserted_at).toLocaleString()}`,
  );

  if (host.telemetry) {
    console.log();
    console.log(`  ${bold("Telemetry")}`);
    renderTelemetry(host.telemetry);
  }
  console.log();
}

function renderTelemetry(t: HostTelemetry): void {
  if (t.cpu_percent !== null) {
    console.log(`    CPU:   ${t.cpu_percent.toFixed(1)}%`);
  }
  if (t.ram_used_mb !== null && t.ram_total_mb !== null) {
    const pct = ((t.ram_used_mb / t.ram_total_mb) * 100).toFixed(1);
    console.log(
      `    RAM:   ${t.ram_used_mb}MB / ${t.ram_total_mb}MB (${pct}%)`,
    );
  }
  if (t.disk_used_gb !== null && t.disk_total_gb !== null) {
    const pct = ((t.disk_used_gb / t.disk_total_gb) * 100).toFixed(1);
    console.log(
      `    Disk:  ${t.disk_used_gb.toFixed(1)}GB / ${t.disk_total_gb.toFixed(1)}GB (${pct}%)`,
    );
  }
}

function colorState(state: string): string {
  switch (state) {
    case "online":
      return chalk.green(state);
    case "offline":
    case "disconnected":
      return chalk.dim(state);
    case "error":
      return chalk.red(state);
    case "pending":
      return chalk.yellow(state);
    default:
      return state;
  }
}

export function register(program: Command): void {
  program
    .command("host <name-or-id>")
    .description("Show details for a specific host")
    .option("--json", "Output as JSON")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const host = await client.getHost(nameOrId);

        if (opts.json) {
          console.log(JSON.stringify(host, null, 2));
          return;
        }

        renderHost(host);
      } catch (err) {
        handleError(err);
      }
    });
}
