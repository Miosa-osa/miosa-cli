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
          try {
            const host = await client.getHost(hostName);
            spinner.stop();
            await uploadPath(
              client,
              host.id,
              src,
              remotePath,
              opts.recursive ?? false,
            );
          } catch (err) {
            spinner.stop();
            await uploadPathToSandbox(
              client,
              hostName,
              src,
              remotePath,
              opts.recursive ?? false,
              err,
            );
          }
        } else {
          // Download: host → local
          const { host: hostName, path: remotePath } = parseHostPath(src);
          const spinner = spin(`Resolving host ${hostName}...`);
          try {
            const host = await client.getHost(hostName);
            spinner.stop();
            await downloadFile(client, host.id, remotePath, dst);
          } catch (err) {
            spinner.stop();
            await downloadPathFromSandbox(
              client,
              hostName,
              remotePath,
              dst,
              err,
            );
          }
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

async function uploadPathToSandbox(
  client: MiosaClient,
  sandboxId: string,
  localPath: string,
  remotePath: string,
  recursive: boolean,
  hostError: unknown,
): Promise<void> {
  await assertSandboxExists(client, sandboxId, hostError);
  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    if (!recursive) {
      throw new UserError(
        `"${localPath}" is a directory. Use -r to copy recursively.`,
      );
    }
    const sourceDir = localPath.endsWith("/.")
      ? path.resolve(localPath.slice(0, -2))
      : path.resolve(localPath);
    const archivePath = createSandboxArchive(sourceDir);
    const remoteArchive = `/tmp/miosa-cp-${Date.now()}.tgz`;
    try {
      await writeSandboxFile(client, sandboxId, remoteArchive, archivePath);
      await execSandbox(
        client,
        sandboxId,
        `mkdir -p ${shellQuote(remotePath)} && tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(remotePath)} && rm -f ${shellQuote(remoteArchive)}`,
      );
    } finally {
      fs.rmSync(archivePath, { force: true });
    }
    console.log(chalk.green(`Uploaded ${sourceDir} → ${sandboxId}:${remotePath}`));
    return;
  }

  const finalRemotePath = remotePath.endsWith("/")
    ? `${remotePath}${path.basename(localPath)}`
    : remotePath;
  await writeSandboxFile(client, sandboxId, finalRemotePath, localPath);
  console.log(chalk.green(`Uploaded ${localPath} → ${sandboxId}:${finalRemotePath}`));
}

async function downloadPathFromSandbox(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
  localDst: string,
  hostError: unknown,
): Promise<void> {
  await assertSandboxExists(client, sandboxId, hostError);
  const kind = await remoteSandboxPathKind(client, sandboxId, remotePath);
  if (kind === "directory") {
    const remoteArchive = `/tmp/miosa-cp-${Date.now()}.tgz`;
    const localDir = path.resolve(localDst);
    const localArchive = path.join(os.tmpdir(), `miosa-cp-${process.pid}-${Date.now()}.tgz`);
    await execSandbox(
      client,
      sandboxId,
      `tar -czf ${shellQuote(remoteArchive)} -C ${shellQuote(remotePath)} .`,
    );
    try {
      const bytes = await readSandboxFile(client, sandboxId, remoteArchive);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(localArchive, bytes);
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
        () => ({}),
      );
    }
    console.log(chalk.green(`Downloaded ${sandboxId}:${remotePath} → ${localDir}`));
    return;
  }

  const bytes = await readSandboxFile(client, sandboxId, remotePath);
  const localPath =
    fs.existsSync(localDst) && fs.statSync(localDst).isDirectory()
      ? path.join(localDst, path.basename(remotePath))
      : localDst;
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  fs.writeFileSync(localPath, bytes);
  console.log(chalk.green(`Downloaded ${sandboxId}:${remotePath} → ${localPath}`));
}

async function assertSandboxExists(
  client: MiosaClient,
  sandboxId: string,
  hostError: unknown,
): Promise<void> {
  try {
    await client.apiGet<unknown>(
      `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
    );
  } catch {
    if (hostError instanceof Error) throw hostError;
    throw new UserError(`Remote target not found: ${sandboxId}`);
  }
}

function createSandboxArchive(sourceDir: string): string {
  const archivePath = path.join(os.tmpdir(), `miosa-cp-${process.pid}-${Date.now()}.tgz`);
  const result = spawnSync(
    "tar",
    [
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
      "--exclude",
      ".next",
      "--exclude",
      "dist",
      "--exclude",
      ".DS_Store",
      "--exclude",
      "._*",
      "--exclude",
      "__MACOSX",
      "-czf",
      archivePath,
      "-C",
      sourceDir,
      ".",
    ],
    { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  if (result.status !== 0) {
    throw new UserError(
      `Could not archive ${sourceDir}: ${result.stderr.toString().trim() || "tar failed"}`,
    );
  }
  return archivePath;
}

async function writeSandboxFile(
  client: MiosaClient,
  sandboxId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  await client.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
    path: remotePath,
    content: fs.readFileSync(localPath).toString("base64"),
  });
}

async function execSandbox(
  client: MiosaClient,
  sandboxId: string,
  command: string,
): Promise<Record<string, unknown>> {
  const result = await client.apiPost<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
    { command, cwd: "/", dir: "/" },
  );
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    return (record["data"] && typeof record["data"] === "object"
      ? (record["data"] as Record<string, unknown>)
      : record);
  }
  return {};
}

async function remoteSandboxPathKind(
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
  const encoded = encodeURIComponent(remotePath.replace(/^\//, ""));
  const result = await client.apiGet<unknown>(
    `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/${encoded}`,
  );
  const data =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as Record<string, unknown>)["data"] ?? result)
      : result;
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    typeof (data as Record<string, unknown>)["content"] === "string"
  ) {
    return Buffer.from((data as Record<string, unknown>)["content"] as string, "base64");
  }
  throw new UserError(`Could not read sandbox file: ${remotePath}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
