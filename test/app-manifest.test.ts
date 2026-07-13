import { describe, expect, it } from "vitest";

import {
  loadProjectManifest,
  manifestDomain,
  manifestResources,
  parseAppManifest,
  validateProjectManifest,
} from "../src/app-manifest.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("app manifest", () => {
  it("loads and validates the canonical sandbox developer contract", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-manifest-"));
    fs.writeFileSync(
      path.join(dir, "miosa.app.yml"),
      `
schema_version: 1
name: clinic-intake
sandbox:
  name: clinic-intake-dev
  template: node
  workdir: /workspace
sync:
  exclude:
    - coverage
dependencies:
  install: npm ci
services:
  web:
    command: npm run dev -- --host 0.0.0.0
    port: 3000
    health:
      path: /health
      timeout: 90
requirements:
  config:
    - NODE_ENV
  secrets:
    - SESSION_SECRET
  database: true
`,
    );

    const loaded = loadProjectManifest(dir);

    expect(loaded.manifest).toMatchObject({
      schema_version: 1,
      name: "clinic-intake",
      sandbox: { workdir: "/workspace" },
      dependencies: { install: "npm ci" },
      services: {
        web: {
          command: "npm run dev -- --host 0.0.0.0",
          port: 3000,
          health: { path: "/health", timeout: 90 },
        },
      },
      requirements: {
        config: ["NODE_ENV"],
        secrets: ["SESSION_SECRET"],
        database: true,
      },
    });
    expect(loaded.manifest.sync?.exclude).toEqual(
      expect.arrayContaining(["coverage", ".git", ".miosa", "node_modules"]),
    );
  });

  it("reports actionable validation issues for unsafe or incomplete manifests", () => {
    const issues = validateProjectManifest(
      parseAppManifest(
        "miosa.app.yml",
        `
schema_version: 1
dependencies:
  install: npm install
services:
  web:
    port: 70000
`,
      ),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MANIFEST_NAME_REQUIRED" }),
        expect.objectContaining({ code: "INSTALL_NOT_DETERMINISTIC" }),
        expect.objectContaining({ code: "SERVICE_COMMAND_REQUIRED", path: "services.web.command" }),
        expect.objectContaining({ code: "SERVICE_PORT_INVALID", path: "services.web.port" }),
      ]),
    );
  });

  it("parses nested resources and domain from YAML", () => {
    const manifest = parseAppManifest(
      "miosa.app.yml",
      `
name: clinic-intake
type: dynamic
build: npm run build
run: npm start
port: 3000
readiness:
  path: /
resources:
  database:
    auto: true
    engine: postgresql
    size: xs
  storage:
    select: bucket_123
  volume: false
domain: intake.apps.cliniciq.com
`,
    );

    expect(manifest.build).toBe("npm run build");
    expect(manifest.run).toBe("npm start");
    expect(manifest.port).toBe(3000);
    expect(manifest.readiness?.path).toBe("/");
    expect(manifestDomain(manifest)).toBe("intake.apps.cliniciq.com");
    expect(manifestResources(manifest)).toEqual({
      database: { auto: true, engine: "postgresql", size: "xs" },
      storage: { select: "bucket_123" },
      volume: false,
      domain: undefined,
    });
  });
});
