import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";
import { handleError } from "./util.js";

interface Volume {
  id: string;
  name: string;
  size_gb?: number;
  region?: string;
  state?: string;
  attached_to?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface VolumeAttachment {
  id: string;
  volume_id?: string;
  host_id?: string;
  machine_id?: string;
  mount_path?: string;
}

function unwrapVolumes(raw: { data?: Volume[]; volumes?: Volume[] } | Volume[]): Volume[] {
  if (Array.isArray(raw)) return raw;
  return raw.data ?? raw.volumes ?? [];
}

function unwrapVolume(raw: { data?: Volume; volume?: Volume } | Volume): Volume {
  if ("data" in raw && raw.data) return raw.data;
  if ("volume" in raw && raw.volume) return raw.volume;
  return raw as Volume;
}

function fmtState(volume: Volume): string {
  const state = volume.state ?? "available";
  if (state === "available" || state === "attached") return chalk.green(state);
  if (state === "creating" || state === "detaching") return chalk.yellow(state);
  if (state === "error" || state === "failed") return chalk.red(state);
  return state;
}

export function register(program: Command): void {
  const volumes = program
    .command("volumes")
    .description("Manage persistent storage volumes");

  volumes
    .command("list")
    .description("List volumes")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Fetching volumes...");
        const rows = unwrapVolumes(await client.apiGet("/api/v1/volumes"));
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        renderTable(rows, [
          { header: "ID", key: (v) => v.id.slice(0, 12), width: 14 },
          { header: "NAME", key: "name", width: 24 },
          {
            header: "SIZE",
            key: (v) => (v.size_gb === undefined ? chalk.dim("unknown") : `${v.size_gb}GB`),
            width: 10,
          },
          { header: "REGION", key: (v) => v.region ?? chalk.dim("default"), width: 14 },
          { header: "STATE", key: fmtState, width: 12 },
          {
            header: "ATTACHED",
            key: (v) => v.attached_to ?? chalk.dim("none"),
            width: 18,
          },
        ]);
      } catch (err) {
        handleError(err);
      }
    });

  volumes
    .command("create <name>")
    .description("Create a persistent volume")
    .option("--size <gb>", "Volume size in GB", "10")
    .option("--region <region>", "Region ID")
    .option("--json", "Output raw JSON")
    .action(
      async (
        name: string,
        opts: { size: string; region?: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin(`Creating volume ${name}...`);
          const volume = unwrapVolume(
            await client.apiPost("/api/v1/volumes", {
              name,
              size_gb: Number.parseInt(opts.size, 10),
              region: opts.region,
            }),
          );
          spinner.succeed(`Created volume ${volume.name}`);
          if (opts.json) console.log(JSON.stringify(volume, null, 2));
        } catch (err) {
          handleError(err);
        }
      },
    );

  volumes
    .command("show <id>")
    .description("Show volume details")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const volume = unwrapVolume(
          await client.apiGet(`/api/v1/volumes/${encodeURIComponent(id)}`),
        );

        if (opts.json) {
          console.log(JSON.stringify(volume, null, 2));
          return;
        }

        console.log();
        console.log(`  ${chalk.bold("ID")}        ${volume.id}`);
        console.log(`  ${chalk.bold("Name")}      ${volume.name}`);
        console.log(`  ${chalk.bold("Size")}      ${volume.size_gb ?? "unknown"}GB`);
        console.log(`  ${chalk.bold("Region")}    ${volume.region ?? "default"}`);
        console.log(`  ${chalk.bold("State")}     ${volume.state ?? "available"}`);
        console.log(`  ${chalk.bold("Attached")}  ${volume.attached_to ?? "none"}`);
        console.log();
      } catch (err) {
        handleError(err);
      }
    });

  volumes
    .command("attach <id>")
    .description("Attach a volume to a machine")
    .requiredOption("--machine <machine>", "Machine or host ID")
    .option("--mount <path>", "Mount path", "/mnt/data")
    .option("--json", "Output raw JSON")
    .action(
      async (
        id: string,
        opts: { machine: string; mount: string; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          const client = new MiosaClient(config);
          const spinner = spin("Attaching volume...");
          const attachment = await client.apiPost<VolumeAttachment>(
            `/api/v1/computers/${encodeURIComponent(opts.machine)}/volumes`,
            { volume_id: id, mount_path: opts.mount },
          );
          spinner.succeed(`Attached volume ${id}`);
          if (opts.json) {
            console.log(JSON.stringify(attachment, null, 2));
            return;
          }
          console.log(`  ${chalk.bold("Attachment")}  ${attachment.id}`);
        } catch (err) {
          handleError(err);
        }
      },
    );

  volumes
    .command("detach <attachment-id>")
    .description("Detach a volume attachment")
    .requiredOption("--machine <machine>", "Machine or host ID")
    .option("--json", "Output raw JSON")
    .action(async (attachmentId: string, opts: { machine: string; json?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Detaching volume...");
        const result = await client.apiDelete(
          `/api/v1/computers/${encodeURIComponent(opts.machine)}/volumes/${encodeURIComponent(attachmentId)}`,
        );
        spinner.succeed("Volume detached");
        if (opts.json) console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });

  volumes
    .command("destroy <id>")
    .description("Destroy a persistent volume")
    .option("-f, --force", "Skip confirmation prompt")
    .option("--json", "Output raw JSON")
    .action(async (id: string, opts: { force?: boolean; json?: boolean }) => {
      try {
        if (!opts.force) {
          const { default: inquirer } = await import("inquirer");
          const { ok } = await inquirer.prompt<{ ok: boolean }>([
            {
              type: "confirm",
              name: "ok",
              message: chalk.red(`Destroy volume ${id}? This is irreversible.`),
              default: false,
            },
          ]);
          if (!ok) {
            console.log(chalk.dim("  Cancelled."));
            process.exit(0);
          }
        }

        const config = loadConfig();
        const client = new MiosaClient(config);
        const spinner = spin("Destroying volume...");
        const result = await client.apiDelete(
          `/api/v1/volumes/${encodeURIComponent(id)}`,
        );
        spinner.succeed("Volume destroyed");
        if (opts.json) console.log(JSON.stringify(result ?? { ok: true }, null, 2));
      } catch (err) {
        handleError(err);
      }
    });
}
