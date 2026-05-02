import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface Region {
  id: string;
  label?: string;
  name?: string;
  status?: string;
  active_nodes?: number;
  small_slots_free?: number;
  headroom?: Record<string, number>;
}

function unwrapRegions(raw: { data?: Region[]; regions?: Region[] } | Region[]): Region[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.regions ?? [];
}

function fmtStatus(region: Region): string {
  const status = region.status ?? "available";
  if (status === "available" || status === "active") return chalk.green(status);
  if (status === "degraded") return chalk.yellow(status);
  if (status === "disabled" || status === "offline") return chalk.red(status);
  return status;
}

export function register(program: Command): void {
  async function list(opts: { json?: boolean }): Promise<void> {
    try {
      const config = loadConfig();
      const client = new MiosaClient(config);
      const spinner = spin("Fetching regions...");
      const rows = unwrapRegions(await client.apiGet("/api/v1/regions"));
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      renderTable(rows, [
        { header: "ID", key: "id", width: 16 },
        { header: "NAME", key: (r) => r.label ?? r.name ?? r.id, width: 24 },
        { header: "STATUS", key: fmtStatus, width: 12 },
        {
          header: "NODES",
          key: (r) => String(r.active_nodes ?? 0),
          width: 8,
        },
        {
          header: "SMALL FREE",
          key: (r) =>
            r.small_slots_free === undefined
              ? chalk.dim("unknown")
              : String(r.small_slots_free),
          width: 12,
        },
      ]);
    } catch (err) {
      handleError(err);
    }
  }

  const regions = program
    .command("regions")
    .description("List available MIOSA regions")
    .option("--json", "Output raw JSON")
    .action(list);

  regions
    .command("list")
    .description("List available MIOSA regions")
    .option("--json", "Output raw JSON")
    .action(list);
}
