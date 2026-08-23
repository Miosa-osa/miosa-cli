import { afterEach, describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("miosa deploy process boundary", () => {
  it("completes a first Docker Deploy with closed stdin and one JSON result", async () => {
    const cliRoot = process.cwd();
    const projectDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-headless-deploy-"),
    );
    const isolatedHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-headless-home-"),
    );
    temporaryDirectories.push(projectDirectory, isolatedHome);

    fs.writeFileSync(
      path.join(projectDirectory, "package.json"),
      JSON.stringify({
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "15.0.0" },
      }),
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDirectory });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/acme/headless-app.git"],
      { cwd: projectDirectory },
    );
    execFileSync("git", ["add", "package.json"], { cwd: projectDirectory });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=MIOSA Test",
        "-c",
        "user.email=test@miosa.invalid",
        "commit",
        "-m",
        "test fixture",
      ],
      { cwd: projectDirectory, stdio: "ignore" },
    );

    const deploymentId = "dep-0000-0000-0000-000000000001";
    const buildId = "bld-0000-0000-0000-000000000001";
    let createRequest: Record<string, unknown> | null = null;
    let createTenantHeader: string | undefined;
    const server = http.createServer((request, response) => {
      void (async () => {
        const body = await readRequestBody(request);
        response.setHeader("content-type", "application/json");

        if (
          request.method === "POST" &&
          request.url === "/api/v1/deployments"
        ) {
          createRequest = JSON.parse(body) as Record<string, unknown>;
          createTenantHeader = request.headers["x-miosa-tenant"] as
            | string
            | undefined;
          response.statusCode = 201;
          response.end(
            JSON.stringify({
              data: {
                id: deploymentId,
                name: path.basename(projectDirectory),
                slug: "headless-app",
                state: "pending",
                deployment_product: "docker_deploy",
                docker_deploy_host_id: "ddh-0001",
                metadata: { deployment_product: "docker_deploy" },
              },
              webhook_secret: "whsec_process_test",
            }),
          );
          return;
        }

        if (
          request.method === "POST" &&
          request.url === `/api/v1/deployments/${deploymentId}/redeploy`
        ) {
          response.statusCode = 202;
          response.end(
            JSON.stringify({
              data: {
                id: buildId,
                state: "queued",
                deployment_id: deploymentId,
              },
            }),
          );
          return;
        }

        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
      })();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test API did not bind a TCP port");
    }

    try {
      const result = await runCli(
        cliRoot,
        projectDirectory,
        isolatedHome,
        `http://127.0.0.1:${address.port}`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Deployment name:");
      expect(result.stdout).not.toContain("readline was closed");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        deployment: {
          id: deploymentId,
          deployment_product: "docker_deploy",
          docker_deploy_host_id: "ddh-0001",
        },
        build: { id: buildId, state: "queued" },
        webhook: { secret: "whsec_process_test" },
      });
      expect(createRequest).toMatchObject({
        repo_url: "https://github.com/acme/headless-app",
        branch: "main",
        auto_deploy: true,
        metadata: { deployment_product: "docker_deploy" },
      });
      expect(createTenantHeader).toBe("acme-org");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 15_000);

  it("fails before the API with actionable flags when framework detection is insufficient", async () => {
    const cliRoot = process.cwd();
    const projectDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-unknown-deploy-"),
    );
    const isolatedHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-unknown-home-"),
    );
    temporaryDirectories.push(projectDirectory, isolatedHome);
    fs.writeFileSync(
      path.join(projectDirectory, "README.md"),
      "# Unknown app\n",
    );
    initializeGitProject(
      projectDirectory,
      "https://github.com/acme/unknown-app.git",
      ["README.md"],
    );

    const result = await runCli(
      cliRoot,
      projectDirectory,
      isolatedHome,
      "http://127.0.0.1:1",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("Deployment name:");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        message: "Could not determine deployment commands non-interactively.",
      },
    });
    expect(result.stdout).toContain("--build-command");
    expect(result.stdout).toContain("--run-command");
  }, 15_000);
});

function initializeGitProject(
  directory: string,
  remote: string,
  files: string[],
): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: directory });
  execFileSync("git", ["add", ...files], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=MIOSA Test",
      "-c",
      "user.email=test@miosa.invalid",
      "commit",
      "-m",
      "test fixture",
    ],
    { cwd: directory, stdio: "ignore" },
  );
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function runCli(
  cliRoot: string,
  cwd: string,
  isolatedHome: string,
  endpoint: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(cliRoot, "node_modules", ".bin", "tsx"),
      [
        path.join(cliRoot, "src", "bin", "miosa.ts"),
        "--json",
        "--organization",
        "acme-org",
        "deploy",
        "--docker-deploy",
      ],
      {
        cwd,
        env: {
          ...process.env,
          CI: "1",
          HOME: isolatedHome,
          MIOSA_API_KEY: "msk_u_process_test",
          MIOSA_ENDPOINT: endpoint,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
