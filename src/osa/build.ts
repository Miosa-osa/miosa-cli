import fs from "node:fs";
import path from "node:path";
import { UserError } from "../errors.js";
import { artifactRoot, relativePath } from "./paths.js";
import { discoverOsaProject } from "./discovery.js";
import type { OsaBuildArtifact } from "./types.js";

export function buildOsaProject(options: {
  target?: string;
  cwd?: string;
} = {}): OsaBuildArtifact {
  const discovery = discoverOsaProject(options);
  if (discovery.manifest.diagnostics.errors > 0) {
    throw new UserError(
      "OSA project has blocking diagnostics.",
      "Run `miosa osa info` and fix errors before building.",
    );
  }

  const artifact: OsaBuildArtifact = {
    version: 1,
    builtAt: new Date().toISOString(),
    projectRoot: discovery.manifest.projectRoot,
    manifestPath: relativePath(
      discovery.manifest.projectRoot,
      path.join(artifactRoot(discovery.manifest.projectRoot), "osa-manifest.json"),
    ),
    diagnosticsPath: relativePath(
      discovery.manifest.projectRoot,
      path.join(artifactRoot(discovery.manifest.projectRoot), "osa-diagnostics.json"),
    ),
    errors: discovery.manifest.diagnostics.errors,
    warnings: discovery.manifest.diagnostics.warnings,
  };

  fs.writeFileSync(
    path.join(artifactRoot(discovery.manifest.projectRoot), "osa-build.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );

  return artifact;
}
