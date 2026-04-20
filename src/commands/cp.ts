import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { ProgressBar } from "../ui/progress.js";
import { spin } from "../ui/spinner.js";

export function register(program: Command): void {
  program
    .command("cp <src> <dst>")
    .description(
      "Copy files between local and host (host:/path syntax for remote)",
    )
    .option("-r, --recursive", "Copy directories recursively")
    .action(async (src: string, dst: string, opts: { recursive?: boolean }) => {
      try {
        const config = loadConfig();
        const client = new MiosaClient(config);

        const srcIsRemote = src.includes(":");
        const dstIsRemote = dst.includes(":");

        if (srcIsRemote && dstIsRemote) {
          console.error(
            chalk.red("Remote-to-remote copy is not supported yet."),
          );
          process.exit(1);
        }

        if (!srcIsRemote && !dstIsRemote) {
          console.error(
            chalk.red(
              "At least one path must be remote (host:/path). Use system cp for local copies.",
            ),
          );
          process.exit(1);
        }

        if (!srcIsRemote && dstIsRemote) {
          // Upload: local → host
          const { host: hostName, path: remotePath } = parseHostPath(dst);
          const spinner = spin(`Resolving host ${hostName}...`);
          const host = await client.getHost(hostName);
          spinner.stop();

          await uploadPath(
            client,
            host.id,
            src,
            remotePath,
            opts.recursive ?? false,
          );
        } else {
          // Download: host → local
          const { host: hostName, path: remotePath } = parseHostPath(src);
          const spinner = spin(`Resolving host ${hostName}...`);
          const host = await client.getHost(hostName);
          spinner.stop();

          await downloadFile(client, host.id, remotePath, dst);
        }
      } catch (err) {
        handleError(err);
      }
    });
}

async function uploadPath(
  client: MiosaClient,
  hostId: string,
  localPath: string,
  remotePath: string,
  recursive: boolean,
): Promise<void> {
  const stat = fs.statSync(localPath);

  if (stat.isDirectory()) {
    if (!recursive) {
      console.error(
        chalk.red(`"${localPath}" is a directory. Use -r to copy recursively.`),
      );
      process.exit(1);
    }
    const entries = fs.readdirSync(localPath);
    for (const entry of entries) {
      const entryLocal = path.join(localPath, entry);
      const entryRemote = remotePath.replace(/\/$/, "") + "/" + entry;
      await uploadPath(client, hostId, entryLocal, entryRemote, recursive);
    }
    return;
  }

  const filename = path.basename(localPath);
  const finalRemotePath = remotePath.endsWith("/")
    ? remotePath + filename
    : remotePath;

  const data = fs.readFileSync(localPath);
  const bar = new ProgressBar(`Uploading ${filename}`);
  bar.update(0, data.length);

  await client.uploadFile(
    hostId as Parameters<typeof client.uploadFile>[0],
    finalRemotePath,
    data,
    filename,
  );

  bar.update(data.length, data.length);
  bar.done();
  console.log(chalk.green(`Uploaded ${localPath} → ${remotePath}`));
}

async function downloadFile(
  client: MiosaClient,
  hostId: string,
  remotePath: string,
  localDst: string,
): Promise<void> {
  const filename = path.basename(remotePath);
  let localPath = localDst;

  if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
    localPath = path.join(localPath, filename);
  }

  const res = await client.downloadFile(
    hostId as Parameters<typeof client.downloadFile>[0],
    remotePath,
  );

  const contentLength = parseInt(
    (res.headers as Record<string, string>)["content-length"] ?? "0",
    10,
  );

  const bar = new ProgressBar(`Downloading ${filename}`);
  const out = fs.createWriteStream(localPath);
  let received = 0;

  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    out.write(buf);
    received += buf.length;
    if (contentLength > 0) {
      bar.update(received, contentLength);
    }
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  bar.done();
  console.log(chalk.green(`Downloaded ${remotePath} → ${localPath}`));
}
