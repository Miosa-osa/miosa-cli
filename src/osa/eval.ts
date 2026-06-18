import fs from "node:fs";
import path from "node:path";
import { readYamlObject } from "./yaml.js";
import { discoverOsaProject } from "./discovery.js";
import type { OsaDiagnostic, OsaEvalReport, OsaEvalResult } from "./types.js";

export function runOsaEvals(options: {
  target?: string;
  cwd?: string;
  strict?: boolean;
} = {}): OsaEvalReport {
  const diagnostics: OsaDiagnostic[] = [];
  const discovery = discoverOsaProject(options);
  const results: OsaEvalResult[] = [];

  if (discovery.manifest.diagnostics.errors > 0) {
    results.push({
      name: "project-diagnostics",
      path: ".miosa/osa-diagnostics.json",
      status: "failed",
      checks: [
        {
          name: "no_errors",
          status: "failed",
          detail: `${discovery.manifest.diagnostics.errors} blocking diagnostic(s).`,
        },
      ],
    });
  }

  for (const evalFile of discovery.manifest.evals) {
    const fullPath = path.join(discovery.manifest.projectRoot, evalFile.path);
    const checks: OsaEvalResult["checks"] = [];
    let status: OsaEvalResult["status"] = "passed";

    if (/\.(ya?ml)$/.test(evalFile.path)) {
      const config = readYamlObject(discovery.manifest.projectRoot, fullPath, diagnostics);
      if (!config["prompt"]) {
        status = "failed";
        checks.push({
          name: "prompt_present",
          status: "failed",
          detail: "Eval descriptor is missing prompt.",
        });
      } else {
        checks.push({
          name: "prompt_present",
          status: "passed",
          detail: "Prompt is present.",
        });
      }
      if (!Array.isArray(config["checks"])) {
        status = "failed";
        checks.push({
          name: "checks_present",
          status: "failed",
          detail: "Eval descriptor is missing checks array.",
        });
      } else {
        checks.push({
          name: "checks_present",
          status: "passed",
          detail: "Checks are present.",
        });
      }
    } else if (fs.existsSync(fullPath)) {
      checks.push({
        name: "file_present",
        status: "passed",
        detail: "Eval file exists.",
      });
    } else {
      status = "failed";
      checks.push({
        name: "file_present",
        status: "failed",
        detail: "Eval file is missing.",
      });
    }

    results.push({
      name: evalFile.name,
      path: evalFile.path,
      status,
      checks,
    });
  }

  if (results.length === 0) {
    results.push({
      name: "evals-present",
      path: "evals",
      status: options.strict ? "failed" : "passed",
      checks: [
        {
          name: "has_evals",
          status: options.strict ? "failed" : "passed",
          detail: options.strict
            ? "No eval files discovered."
            : "No eval files discovered; non-strict mode allows this.",
        },
      ],
    });
  }

  const allDiagnostics = [...discovery.diagnostics, ...diagnostics];
  const failed = results.filter((result) => result.status === "failed").length;
  return {
    ok: failed === 0,
    projectRoot: discovery.manifest.projectRoot,
    results,
    errors: allDiagnostics.filter((item) => item.severity === "error").length,
    warnings: allDiagnostics.filter((item) => item.severity === "warning").length,
  };
}
