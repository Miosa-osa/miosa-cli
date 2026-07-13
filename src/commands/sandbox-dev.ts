import type { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { loadProjectManifest, type MiosaAppManifest } from "../app-manifest.js";
import { loadConfig } from "../config.js";
import { MiosaClient } from "../client.js";
import { ApiResponseError, MiosaError, UserError } from "../errors.js";
import { handleError, isJsonMode } from "./util.js";

interface DevState {
  schema_version: 1;
  project: string;
  sandbox_id: string;
  updated_at: string;
}

interface DevServiceResult {
  healthy: boolean;
  port: number;
  health_path: string;
  preview_url: string;
  internal_status: number | null;
  edge_status: number | null;
}

interface DevUpResult {
  ok: true;
  sandbox_id: string;
  reused: boolean;
  manifest: string;
  services: Record<string, DevServiceResult>;
}

export interface SandboxDoctorCheck {
  id: string;
  ok: boolean;
  code: string;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface SandboxDoctorFullResult {
  ok: boolean;
  sandbox_id: string;
  manifest: string;
  failure_codes: string[];
  checks: SandboxDoctorCheck[];
}

export function registerSandboxDevCommands(sandbox: Command): void {
  const dev = sandbox
    .command("dev")
    .description("Run the canonical project manifest in a persistent development sandbox");

  dev
    .command("up")
    .description("Create or reuse, sync, install, start, and prove development services")
    .option("--dir <path>", "Project directory containing miosa.app.yml", ".")
    .option("--sandbox <id>", "Reuse this sandbox and update local resumability state")
    .option("--json", "Output stable machine-readable JSON")
    .action(async (opts: { dir: string; sandbox?: string; json?: boolean }) => {
      try {
        const result = await devUp(opts.dir, opts.sandbox, (step) => {
          if (!isJsonMode(opts)) console.error(chalk.dim(`-> ${step}`));
        });
        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log();
        console.log(`Sandbox  ${result.sandbox_id}${result.reused ? " (reused)" : ""}`);
        for (const [name, service] of Object.entries(result.services)) {
          console.log(`${name}  ${chalk.cyan(service.preview_url)}`);
        }
        console.log();
      } catch (error) {
        handleError(withDevRecovery(error, path.resolve(opts.dir)));
      }
    });
}

export async function runFullSandboxDoctor(
  projectDirInput: string,
  sandboxOverride?: string,
): Promise<SandboxDoctorFullResult> {
  const projectDir = path.resolve(projectDirInput);
  const loaded = loadProjectManifest(projectDir);
  const manifest = loaded.manifest;
  const saved = readDevState(projectDir);
  const sandboxId = sandboxOverride ?? saved?.sandbox_id;
  if (!sandboxId) {
    throw new UserError(
      "No sandbox ID was provided and no resumability state exists.",
      `Run miosa sandbox dev up --dir ${quote(projectDir)} first, or pass a sandbox ID.`,
    );
  }
  const api = new MiosaClient(loadConfig());
  const checks: SandboxDoctorCheck[] = [];
  let sandbox: Record<string, unknown> = {};

  try {
    sandbox = unwrapRecord(
      await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`),
    );
    const state = String(sandbox["state"] ?? sandbox["status"] ?? "unknown");
    checks.push({
      id: "api_state",
      ok: ["running", "ready"].includes(state.toLowerCase()),
      code: ["running", "ready"].includes(state.toLowerCase())
        ? "API_STATE_OK"
        : "API_STATE_NOT_RUNNING",
      message: `Sandbox API state is ${state}.`,
      remediation: `Run miosa sandbox resume ${sandboxId} --json, then retry.`,
      details: { state },
    });
  } catch (error) {
    checks.push(failedCheck("api_state", "API_STATE_UNAVAILABLE", error, `Verify with miosa sandbox show ${sandboxId} --json.`));
  }

  try {
    const result = await execRaw(api, sandboxId, "printf 'MIOSA_EXEC_OK\\n'", "/", 10);
    const ok = Number(result["exit_code"] ?? 0) === 0 && String(result["stdout"] ?? "").includes("MIOSA_EXEC_OK");
    checks.push({
      id: "exec_channel",
      ok,
      code: ok ? "EXEC_CHANNEL_OK" : "EXEC_CHANNEL_FAILED",
      message: ok ? "Sandbox exec channel responded." : "Sandbox exec channel returned an unexpected result.",
      remediation: `Retry miosa sandbox exec ${sandboxId} --cmd "printf MIOSA_EXEC_OK" --json.`,
    });
  } catch (error) {
    checks.push(failedCheck("exec_channel", "EXEC_CHANNEL_FAILED", error, `Retry miosa sandbox exec ${sandboxId} --cmd "printf MIOSA_EXEC_OK" --json.`));
  }

  const workdir = manifest.sandbox?.workdir ?? "/workspace";
  try {
    const result = await execRaw(api, sandboxId, `test -d ${quote(workdir)} && printf '%s\\n' ${quote(workdir)}`, "/", 10);
    const ok = Number(result["exit_code"] ?? 0) === 0;
    checks.push({
      id: "filesystem",
      ok,
      code: ok ? "FILESYSTEM_OK" : "FILESYSTEM_WORKDIR_MISSING",
      message: ok ? `Project workdir ${workdir} is accessible.` : `Project workdir ${workdir} is missing.`,
      remediation: `Resume sync with miosa sandbox dev up --dir ${quote(projectDir)} --sandbox ${sandboxId}.`,
      details: { workdir },
    });
  } catch (error) {
    checks.push(failedCheck("filesystem", "FILESYSTEM_UNAVAILABLE", error, `Resume sync with miosa sandbox dev up --dir ${quote(projectDir)} --sandbox ${sandboxId}.`));
  }

  for (const [name, service] of Object.entries(manifest.services ?? {})) {
    try {
      const row = unwrapRecord(
        await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/services/${encodeURIComponent(name)}`),
      );
      const status = String(row["status"] ?? "unknown");
      const ok = status === "running";
      checks.push({
        id: `service:${name}`,
        ok,
        code: ok ? "SERVICE_RUNNING" : "SERVICE_NOT_RUNNING",
        message: `${name} service status is ${status}.`,
        remediation: `Run miosa sandbox dev up --dir ${quote(projectDir)} --sandbox ${sandboxId}.`,
        details: { service: name, status },
      });
    } catch (error) {
      checks.push(failedCheck(`service:${name}`, "SERVICE_UNAVAILABLE", error, `Run miosa sandbox dev up --dir ${quote(projectDir)} --sandbox ${sandboxId}.`));
    }

    try {
      const result = await execRaw(
        api,
        sandboxId,
        `python3 -c ${quote(`import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:${service.port}${normalizeHealthPath(service.health?.path ?? "/")}', timeout=3); print(r.status)`)}`,
        "/",
        10,
      );
      const status = Number(String(result["stdout"] ?? "").trim().split(/\s+/)[0]);
      const ok = Number(result["exit_code"] ?? 0) === 0 && status >= 200 && status < 400;
      checks.push({
        id: `listener:${name}`,
        ok,
        code: ok ? "SERVICE_LISTENER_OK" : "SERVICE_LISTENER_FAILED",
        message: ok ? `${name} answered internally with HTTP ${status}.` : `${name} did not answer on port ${service.port}.`,
        remediation: `Inspect miosa sandbox service logs ${sandboxId} ${name} --json.`,
        details: { service: name, port: service.port, status: Number.isFinite(status) ? status : null },
      });
    } catch (error) {
      checks.push(failedCheck(`listener:${name}`, "SERVICE_LISTENER_FAILED", error, `Inspect miosa sandbox service logs ${sandboxId} ${name} --json.`));
    }

    try {
      const exposed = unwrapRecord(
        await api.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/expose`, {
          port: service.port,
          title: `${manifest.name} ${name} doctor`,
        }),
      );
      const url = textField(exposed, "url") ?? textField(exposed, "preview_url");
      if (!url) throw new Error("Expose response did not include a URL.");
      const status = await probePreview(url, service.health?.path ?? "/");
      const ok = status >= 200 && status < 400;
      checks.push({
        id: `preview:${name}`,
        ok,
        code: ok ? "PREVIEW_ROUTE_OK" : "PREVIEW_ROUTE_FAILED",
        message: `Preview route answered with HTTP ${status}.`,
        remediation: `Recreate and inspect with miosa sandbox preview ${sandboxId} --port ${service.port} --wait --json.`,
        details: { service: name, port: service.port, url, status },
      });
    } catch (error) {
      checks.push(failedCheck(`preview:${name}`, "PREVIEW_ROUTE_FAILED", error, `Recreate and inspect with miosa sandbox preview ${sandboxId} --port ${service.port} --wait --json.`));
    }
  }

  const databaseId = databaseAttachmentId(sandbox);
  const databaseRequired = manifest.requirements?.database === true;
  checks.push({
    id: "database",
    ok: !databaseRequired || Boolean(databaseId),
    code: !databaseRequired || databaseId ? "DATABASE_ATTACHMENT_OK" : "DATABASE_ATTACHMENT_MISSING",
    message: databaseId
      ? `Managed database attachment ${databaseId} is present.`
      : databaseRequired
        ? "A managed database attachment is required but missing."
        : "No managed database attachment is required.",
    remediation: `Attach one with miosa sandbox db attach ${sandboxId} <database-id> --json.`,
    details: { required: databaseRequired, attached: Boolean(databaseId), database_id: databaseId },
  });

  let envNames = new Set<string>();
  try {
    const raw = unwrapValue(await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/env`));
    const rows = Array.isArray(raw) ? raw : [];
    envNames = new Set(
      rows.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        const name = row["name"] ?? row["key"];
        return typeof name === "string" ? [name] : [];
      }),
    );
  } catch (error) {
    checks.push(failedCheck("environment", "ENVIRONMENT_INSPECTION_FAILED", error, `Inspect names with miosa sandbox env list ${sandboxId} --json.`));
  }
  for (const name of manifest.requirements?.config ?? []) {
    const ok = envNames.has(name);
    checks.push({
      id: `config:${name}`,
      ok,
      code: ok ? "CONFIG_PRESENT" : "CONFIG_MISSING",
      message: ok ? `Config ${name} is present.` : `Config ${name} is missing.`,
      remediation: `Set ${name} with miosa sandbox env set ${sandboxId} ${name}=<value>.`,
      details: { name, present: ok },
    });
  }
  for (const name of manifest.requirements?.secrets ?? []) {
    const ok = envNames.has(name);
    checks.push({
      id: `secret:${name}`,
      ok,
      code: ok ? "SECRET_PRESENT" : "SECRET_MISSING",
      message: ok ? `Secret ${name} is present.` : `Secret ${name} is missing.`,
      remediation: `Set ${name} through miosa sandbox env set ${sandboxId} without logging its value.`,
      details: { name, present: ok },
    });
  }

  try {
    await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`);
    checks.push({
      id: "snapshot",
      ok: true,
      code: "SNAPSHOT_CAPABLE",
      message: "Sandbox snapshot capability is available.",
    });
  } catch (error) {
    checks.push(failedCheck("snapshot", "SNAPSHOT_UNAVAILABLE", error, `Verify with miosa sandbox snapshots list ${sandboxId} --json.`));
  }

  const failureCodes = checks.filter((check) => !check.ok).map((check) => check.code);
  return {
    ok: failureCodes.length === 0,
    sandbox_id: sandboxId,
    manifest: loaded.path,
    failure_codes: failureCodes,
    checks,
  };
}

async function devUp(
  projectDirInput: string,
  sandboxOverride: string | undefined,
  step: (message: string) => void,
): Promise<DevUpResult> {
  const projectDir = path.resolve(projectDirInput);
  const loaded = loadProjectManifest(projectDir);
  const manifest = loaded.manifest;
  const api = new MiosaClient(loadConfig());
  const saved = readDevState(projectDir);
  const explicitlySelected = Boolean(sandboxOverride);
  let sandboxId =
    sandboxOverride ??
    (saved && saved.project === manifest.name ? saved.sandbox_id : null);
  let reused = Boolean(sandboxId);

  if (sandboxId) {
    step(`Validating sandbox ${sandboxId}`);
    try {
      const row = unwrapRecord(await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`));
      if (isTerminalSandbox(row)) {
        if (explicitlySelected) {
          throw new UserError(`Explicitly selected sandbox ${sandboxId} is in a terminal state.`);
        }
        sandboxId = null;
        reused = false;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (explicitlySelected) {
        throw new UserError(`Explicitly selected sandbox ${sandboxId} was not found.`);
      }
      sandboxId = null;
      reused = false;
    }
  }

  if (!sandboxId) {
    step("Creating persistent sandbox");
    const created = unwrapRecord(
      await api.apiPost("/api/v1/sandboxes", {
        name: manifest.sandbox?.name ?? `${manifest.name}-dev`,
        template_id: manifest.sandbox?.template ?? manifest.template ?? "miosa-sandbox",
        persistent: true,
      }),
    );
    sandboxId = textField(created, "id");
    if (!sandboxId) throw new UserError("Sandbox create response did not include an id.");
    writeDevState(projectDir, {
      schema_version: 1,
      project: manifest.name!,
      sandbox_id: sandboxId,
      updated_at: new Date().toISOString(),
    });
  } else if (sandboxOverride || saved?.project !== manifest.name) {
    writeDevState(projectDir, {
      schema_version: 1,
      project: manifest.name!,
      sandbox_id: sandboxId,
      updated_at: new Date().toISOString(),
    });
  }

  step("Waiting for sandbox API state");
  await waitForRunning(api, sandboxId, 120);
  step("Overlay-syncing project files without deleting runtime paths");
  await syncProject(api, sandboxId, projectDir, manifest);
  if (manifest.dependencies?.install !== false && manifest.dependencies?.install) {
    step(`Installing dependencies with ${manifest.dependencies.install}`);
    await installDependencies(api, sandboxId, projectDir, manifest);
  }

  const services: Record<string, DevServiceResult> = {};
  for (const [name, service] of Object.entries(manifest.services ?? {})) {
    const port = service.port!;
    const healthPath = service.health?.path ?? "/";
    const cwd = remoteCwd(manifest, service.cwd);
    step(`Starting service ${name}`);
    let exists = false;
    try {
      await api.apiGet(
        `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/services/${encodeURIComponent(name)}`,
      );
      exists = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (exists) {
      await api.apiPost(
        `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/services/${encodeURIComponent(name)}/restart`,
        {},
      );
    } else {
      await api.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/services`, {
        name,
        command: service.command,
        cwd,
      });
    }

    step(`Waiting for ${name} health`);
    const internal = await waitForInternalHealth(
      api,
      sandboxId,
      port,
      healthPath,
      service.health?.timeout ?? 120,
    );
    const exposed = unwrapRecord(
      await api.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/expose`, {
        port,
        title: `${manifest.name} ${name}`,
      }),
    );
    const previewUrl = textField(exposed, "url") ?? textField(exposed, "preview_url");
    if (!previewUrl) throw new UserError(`Preview route for ${name} did not return a URL.`);
    const edgeStatus = await probePreview(previewUrl, healthPath);
    if (edgeStatus < 200 || edgeStatus >= 400) {
      throw new UserError(
        `Preview health failed for ${name} with HTTP ${edgeStatus}.`,
        `Inspect with miosa sandbox doctor ${sandboxId} --full --json.`,
      );
    }
    services[name] = {
      healthy: true,
      port,
      health_path: healthPath,
      preview_url: previewUrl,
      internal_status: internal,
      edge_status: edgeStatus,
    };
  }

  return {
    ok: true,
    sandbox_id: sandboxId,
    reused,
    manifest: loaded.path,
    services,
  };
}

async function syncProject(
  api: MiosaClient,
  sandboxId: string,
  projectDir: string,
  manifest: MiosaAppManifest,
): Promise<void> {
  const archive = path.join(os.tmpdir(), `miosa-dev-${process.pid}-${Date.now()}.tgz`);
  const excludes = manifest.sync?.exclude ?? [];
  const args = excludes.flatMap((entry) => ["--exclude", entry]);
  const tar = spawnSync(
    "tar",
    [...args, "-czf", archive, "-C", projectDir, "."],
    { stdio: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  if (tar.status !== 0) {
    throw new UserError(`Could not archive project: ${tar.stderr.toString().trim() || "tar failed"}`);
  }
  try {
    await api.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
      path: "/tmp/miosa-dev-sync.tgz",
      content: fs.readFileSync(archive).toString("base64"),
    });
    const workdir = manifest.sandbox?.workdir ?? "/workspace";
    await exec(api, sandboxId, `mkdir -p ${quote(workdir)} && tar -xzf /tmp/miosa-dev-sync.tgz -C ${quote(workdir)} && rm -f /tmp/miosa-dev-sync.tgz`, "/");
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function installDependencies(
  api: MiosaClient,
  sandboxId: string,
  projectDir: string,
  manifest: MiosaAppManifest,
): Promise<void> {
  const fingerprint = createHash("sha256");
  const command = manifest.dependencies?.install;
  const lockfiles = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "requirements.lock",
    "package.json",
    ...pipLockfiles(command),
  ]);
  for (const filename of lockfiles) {
    const file = path.join(projectDir, filename);
    if (fs.existsSync(file)) fingerprint.update(filename).update(fs.readFileSync(file));
  }
  const hash = fingerprint.digest("hex").slice(0, 20);
  const marker = `.miosa-runtime/install-${hash}.done`;
  if (!command) return;
  await exec(
    api,
    sandboxId,
    `mkdir -p .miosa-runtime && test -f ${quote(marker)} || (${command} && touch ${quote(marker)})`,
    manifest.sandbox?.workdir ?? "/workspace",
    900,
  );
}

function pipLockfiles(command: string | false | undefined): string[] {
  if (typeof command !== "string") return [];

  const filenames: string[] = [];
  for (const match of command.matchAll(
    /(?:^|\s)(?:-r\s+|--requirement(?:=|\s+))([^\s;&|`<>]+\.lock)(?=\s|$)/g,
  )) {
    const filename = match[1];
    if (!filename) continue;
    if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes("..")) continue;
    filenames.push(filename);
  }
  return filenames;
}

async function waitForRunning(api: MiosaClient, sandboxId: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const row = unwrapRecord(await api.apiGet(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`));
    const state = String(row["state"] ?? row["status"] ?? "").toLowerCase();
    if (state === "running" || state === "ready") return;
    if (["failed", "destroyed", "error"].includes(state)) {
      throw new UserError(`Sandbox ${sandboxId} entered ${state} state.`);
    }
    await sleep(1_000);
  }
  throw new UserError(`Sandbox ${sandboxId} did not become running within ${timeout}s.`);
}

async function waitForInternalHealth(
  api: MiosaClient,
  sandboxId: string,
  port: number,
  healthPath: string,
  timeout: number,
): Promise<number> {
  const deadline = Date.now() + timeout * 1000;
  let last = "not listening";
  while (Date.now() < deadline) {
    const result = await execRaw(
      api,
      sandboxId,
      `python3 -c ${quote(`import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:${port}${normalizeHealthPath(healthPath)}', timeout=3); print(r.status)` )}`,
      "/",
      10,
    );
    const status = Number(String(result["stdout"] ?? "").trim().split(/\s+/)[0]);
    if (Number(result["exit_code"] ?? 0) === 0 && status >= 200 && status < 400) return status;
    last = String(result["stderr"] ?? result["stdout"] ?? last).trim();
    await sleep(1_000);
  }
  throw new UserError(
    `Service on port ${port} did not become healthy within ${timeout}s.`,
    last || "Inspect service logs and listener state with miosa sandbox doctor --full.",
  );
}

async function probePreview(baseUrl: string, healthPath: string): Promise<number> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${normalizeHealthPath(healthPath)}`;
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}

async function exec(
  api: MiosaClient,
  sandboxId: string,
  command: string,
  cwd: string,
  timeout?: number,
): Promise<Record<string, unknown>> {
  const result = await execRaw(api, sandboxId, command, cwd, timeout);
  const exitCode = Number(result["exit_code"] ?? 0);
  if (exitCode !== 0) {
    throw new UserError(
      `Sandbox command failed with exit code ${exitCode}: ${command}`,
      String(result["stderr"] ?? result["stdout"] ?? ""),
    );
  }
  return result;
}

async function execRaw(
  api: MiosaClient,
  sandboxId: string,
  command: string,
  cwd: string,
  timeout?: number,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { command: `cd ${quote(cwd)} && ${command}`, cwd, dir: cwd };
  if (timeout != null) body["timeout"] = timeout;
  return unwrapRecord(
    await api.apiPost(`/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, body),
  );
}

function readDevState(projectDir: string): DevState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(projectDir), "utf8")) as DevState;
  } catch {
    return null;
  }
}

function writeDevState(projectDir: string, state: DevState): void {
  const target = statePath(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function statePath(projectDir: string): string {
  return path.join(projectDir, ".miosa", "sandbox.json");
}

function remoteCwd(manifest: MiosaAppManifest, serviceCwd?: string): string {
  const root = manifest.sandbox?.workdir ?? "/workspace";
  if (!serviceCwd || serviceCwd === ".") return root;
  if (serviceCwd.startsWith("/")) return serviceCwd;
  return path.posix.join(root, serviceCwd);
}

function unwrapRecord(value: unknown): Record<string, unknown> {
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const data = root["data"];
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : root;
}

function unwrapValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  return "data" in root ? root["data"] : root;
}

function failedCheck(
  id: string,
  code: string,
  error: unknown,
  remediation: string,
): SandboxDoctorCheck {
  return {
    id,
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
    remediation,
  };
}

function databaseAttachmentId(sandbox: Record<string, unknown>): string | null {
  for (const key of ["database_id", "attached_database_id"]) {
    const value = sandbox[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const database = sandbox["database"];
  if (database && typeof database === "object" && !Array.isArray(database)) {
    return textField(database as Record<string, unknown>, "id");
  }
  const databases = sandbox["databases"];
  if (Array.isArray(databases) && databases.length > 0) {
    const first = databases[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return textField(first as Record<string, unknown>, "id");
    }
  }
  return null;
}

function textField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isTerminalSandbox(row: Record<string, unknown>): boolean {
  const state = String(row["state"] ?? row["status"] ?? "").toLowerCase();
  return ["destroyed", "deleted", "failed", "error"].includes(state);
}

function isNotFound(error: unknown): boolean {
  return error instanceof MiosaError && /not found/i.test(error.message);
}

function withDevRecovery(error: unknown, projectDir: string): unknown {
  if (!(error instanceof MiosaError)) return error;
  const saved = readDevState(projectDir);
  if (!saved) return error;
  const recovery = `Resume with miosa sandbox dev up --dir ${quote(projectDir)} --sandbox ${quote(saved.sandbox_id)}, or inspect with miosa sandbox doctor ${quote(saved.sandbox_id)} --full --json.`;
  const hint = error.hint ? `${error.hint} ${recovery}` : recovery;
  if (error instanceof ApiResponseError) {
    return new ApiResponseError(
      error.code,
      error.message,
      error.exitCode,
      error.retryable,
      hint,
      error.details,
      error.requestId,
    );
  }
  return new MiosaError(
    error.message,
    error.exitCode,
    hint,
    error.details,
    error.requestId,
  );
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeHealthPath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
