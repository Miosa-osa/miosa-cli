import type { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { handleError, parseHostPath } from "./util.js";
import { ProgressBar } from "../ui/progress.js";
import { spin } from "../ui/spinner.js";
import { UserError } from "../errors.js";

const SANDBOX_ID_RE = /^(sbx_|sb_)/;

function isSandboxId(hostName: string): boolean {
  return SANDBOX_ID_RE.test(hostName);
}

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
          if (isSandboxId(hostName)) {
            await uploadSandboxPath(
              client,
              hostName,
              src,
              remotePath,
              opts.recursive ?? false,
            );
            return;
          }

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
          if (isSandboxId(hostName)) {
            await downloadSandboxPath(client, hostName, remotePath, dst);
            return;
          }

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

async function uploadSandboxPath(
  client: MiosaClient,
  sandboxId: string,
  localPath: string,
  remotePath: string,
  recursive: boolean,
): Promise<void> {
  const stat = fs.statSync(localPath);

  if (stat.isDirectory()) {
    if (!recursive) {
      throw new UserError(
        `"${localPath}" is a directory. Use -r to copy recursively.`,
      );
    }
    await uploadSandboxDirectory(client, sandboxId, localPath, remotePath);
    console.log(chalk.green(`Copied ${localPath} → ${sandboxId}:${remotePath}`));
    return;
  }

  await uploadSandboxFile(client, sandboxId, localPath, remotePath);
  console.log(chalk.green(`Copied ${localPath} → ${sandboxId}:${remotePath}`));
}

async function uploadSandboxFile(
  client: MiosaClient,
  sandboxId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const stat = fs.statSync(localPath);
  const filename = path.basename(localPath);
  const finalRemotePath = remotePath.endsWith("/")
    ? remotePath + filename
    : remotePath;
  const data = fs.readFileSync(localPath);
  const bar = new ProgressBar(`Uploading ${filename}`);
  bar.update(0, stat.size);
  await client.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
    path: finalRemotePath,
    content: data.toString("base64"),
  });
  bar.update(stat.size, stat.size);
  bar.done();
}

async function uploadSandboxDirectory(
  client: MiosaClient,
  sandboxId: string,
  localDir: string,
  remoteDir: string,
): Promise<void> {
  const archivePath = path.join(
    os.tmpdir(),
    `miosa-cp-${process.pid}-${Date.now()}.tgz`,
  );
  const result = spawnSync(
    "tar",
    [
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
      "--exclude",
      ".DS_Store",
      "--exclude",
      "._*",
      "--exclude",
      "__MACOSX",
      "-czf",
      archivePath,
      "-C",
      path.resolve(localDir),
      ".",
    ],
    { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  if (result.status !== 0) {
    throw new UserError(
      `Could not archive ${localDir}: ${result.stderr.toString().trim() || "tar failed"}`,
    );
  }

  const remoteArchive = `/tmp/miosa-cp-${Date.now()}.tgz`;
  try {
    await uploadSandboxFile(client, sandboxId, archivePath, remoteArchive);
    await execSandbox(client, sandboxId, [
      `rm -rf ${shellQuote(remoteDir)}`,
      `mkdir -p ${shellQuote(remoteDir)}`,
      `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteDir)}`,
      `rm -f ${shellQuote(remoteArchive)}`,
    ].join(" && "));
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

async function downloadSandboxPath(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
  localDst: string,
): Promise<void> {
  const kind = await sandboxPathKind(client, sandboxId, remotePath);
  if (kind === "directory") {
    await downloadSandboxDirectory(client, sandboxId, remotePath, localDst);
    console.log(chalk.green(`Copied ${sandboxId}:${remotePath} → ${localDst}`));
    return;
  }

  const bytes = await readSandboxFile(client, sandboxId, remotePath);
  const filename = path.basename(remotePath);
  const localPath =
    fs.existsSync(localDst) && fs.statSync(localDst).isDirectory()
      ? path.join(localDst, filename)
      : localDst;
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  fs.writeFileSync(localPath, bytes);
  console.log(chalk.green(`Copied ${sandboxId}:${remotePath} → ${localPath}`));
}

async function downloadSandboxDirectory(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
  localDst: string,
): Promise<void> {
  const remoteArchive = `/tmp/miosa-cp-${Date.now()}.tgz`;
  await execSandbox(
    client,
    sandboxId,
    `tar -czf ${shellQuote(remoteArchive)} -C ${shellQuote(remotePath)} .`,
  );
  const archiveBytes = await readSandboxFile(client, sandboxId, remoteArchive);
  const localDir = path.resolve(localDst);
  fs.mkdirSync(localDir, { recursive: true });
  const localArchive = path.join(
    os.tmpdir(),
    `miosa-cp-download-${process.pid}-${Date.now()}.tgz`,
  );
  fs.writeFileSync(localArchive, archiveBytes);
  try {
    const result = spawnSync("tar", ["-xzf", localArchive, "-C", localDir], {
      stdio: "pipe",
    });
    if (result.status !== 0) {
      throw new UserError(
        `Could not extract ${remotePath}: ${result.stderr.toString().trim() || "tar failed"}`,
      );
    }
  } finally {
    fs.rmSync(localArchive, { force: true });
    await execSandbox(client, sandboxId, `rm -f ${shellQuote(remoteArchive)}`).catch(
      () => undefined,
    );
  }
}

async function sandboxPathKind(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
): Promise<"file" | "directory"> {
  const result = await execSandbox(
    client,
    sandboxId,
    `if [ -d ${shellQuote(remotePath)} ]; then echo directory; elif [ -f ${shellQuote(remotePath)} ]; then echo file; else exit 2; fi`,
  );
  return String(result["stdout"] ?? "").trim() === "directory"
    ? "directory"
    : "file";
}

async function readSandboxFile(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
): Promise<Buffer> {
  const result = await client.apiGet<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/${encodeURIComponent(remotePath.replace(/^\//, ""))}`,
  );
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  const content =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)["content"]
      : null;
  if (typeof content === "string") return Buffer.from(content, "base64");
  if (typeof data === "string") return Buffer.from(data);
  throw new UserError(`Could not read sandbox file: ${remotePath}`);
}

async function execSandbox(
  client: MiosaClient,
  sandboxId: string,
  command: string,
): Promise<Record<string, unknown>> {
  const result = await client.apiPost<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
    { command },
  );
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const row = data as Record<string, unknown>;
  const exitCode = Number(row["exit_code"] ?? 0);
  if (exitCode !== 0) {
    throw new UserError(
      `Sandbox command failed with exit code ${exitCode}`,
      String(row["stderr"] ?? row["stdout"] ?? ""),
    );
  }
  return row;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
