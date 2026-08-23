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
    initializeGitProject(
      projectDirectory,
      "https://github.com/acme/headless-app.git",
      ["package.json"],
    );

    const deploymentId = "dep-0000-0000-0000-000000000001";
    const buildId = "bld-0000-0000-0000-000000000001";
    const api = await startMockDeployApi({
      deploymentId,
      buildId,
      name: path.basename(projectDirectory),
      slug: "headless-app",
      dockerDeployHostId: "ddh-0001",
      webhookSecret: "whsec_process_test",
    });

    try {
      const result = await runCli(
        cliRoot,
        projectDirectory,
        isolatedHome,
        api.endpoint,
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
      expect(api.createRequest()).toMatchObject({
        repo_url: "https://github.com/acme/headless-app",
        branch: "main",
        auto_deploy: true,
        metadata: { deployment_product: "docker_deploy" },
      });
      expect(api.createTenantHeader()).toBe("acme-org");
    } finally {
      await api.close();
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
    expect(result.stdout).toContain("--static");
  }, 15_000);

  it("deploys static HTML with closed stdin and no command fields", async () => {
    const cliRoot = process.cwd();
    const projectDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-static-deploy-"),
    );
    const isolatedHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "miosa-static-home-"),
    );
    temporaryDirectories.push(projectDirectory, isolatedHome);
    fs.writeFileSync(
      path.join(projectDirectory, "index.html"),
      "<h1>Report</h1>\n",
    );
    initializeGitProject(
      projectDirectory,
      "https://github.com/acme/callix-security-report.git",
      ["index.html"],
    );

    const deploymentId = "dep-0000-0000-0000-000000000002";
    const buildId = "bld-0000-0000-0000-000000000002";
    const api = await startMockDeployApi({
      deploymentId,
      buildId,
      name: "callix-security-report",
      slug: "callix-security-report",
      dockerDeployHostId: "ddh-0002",
      webhookSecret: "whsec_static_test",
    });

    try {
      const result = await runCli(
        cliRoot,
        projectDirectory,
        isolatedHome,
        api.endpoint,
        [
          "--static",
          "--name",
          "callix-security-report",
          "--branch",
          "master",
          "--yes",
        ],
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("Build command:");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        deployment: { id: deploymentId, deployment_product: "docker_deploy" },
        build: { id: buildId, state: "queued" },
      });
      expect(api.createRequest()).toMatchObject({
        name: "callix-security-report",
        repo_url: "https://github.com/acme/callix-security-report",
        branch: "master",
        auto_deploy: true,
        metadata: { deployment_product: "docker_deploy" },
      });
      expect(api.createRequest()).not.toHaveProperty("build_command");
      expect(api.createRequest()).not.toHaveProperty("run_command");
    } finally {
      await api.close();
    }
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

interface MockDeployApiFixture {
  deploymentId: string;
  buildId: string;
  name: string;
  slug: string;
  dockerDeployHostId: string;
  webhookSecret: string;
}

interface MockDeployApi {
  endpoint: string;
  createRequest: () => Record<string, unknown> | null;
  createTenantHeader: () => string | undefined;
  close: () => Promise<void>;
}

async function startMockDeployApi(
  fixture: MockDeployApiFixture,
): Promise<MockDeployApi> {
  let createRequest: Record<string, unknown> | null = null;
  let createTenantHeader: string | undefined;
  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      response.setHeader("content-type", "application/json");

      if (request.method === "POST" && request.url === "/api/v1/deployments") {
        createRequest = JSON.parse(body) as Record<string, unknown>;
        createTenantHeader = request.headers["x-miosa-tenant"] as
          string | undefined;
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            data: {
              id: fixture.deploymentId,
              name: fixture.name,
              slug: fixture.slug,
              state: "pending",
              deployment_product: "docker_deploy",
              docker_deploy_host_id: fixture.dockerDeployHostId,
              metadata: { deployment_product: "docker_deploy" },
            },
            webhook_secret: fixture.webhookSecret,
          }),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === `/api/v1/deployments/${fixture.deploymentId}/redeploy`
      ) {
        response.statusCode = 202;
        response.end(
          JSON.stringify({
            data: {
              id: fixture.buildId,
              state: "queued",
              deployment_id: fixture.deploymentId,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test API did not bind a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    createRequest: () => createRequest,
    createTenantHeader: () => createTenantHeader,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
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
  deployArgs: string[] = [],
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
        ...deployArgs,
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
