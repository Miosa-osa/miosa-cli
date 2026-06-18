import process from "node:process";
import { discoverOsaProject } from "./discovery.js";
import type { OsaDiscovery, OsaDoctorCheck } from "./types.js";

export function runOsaDoctor(options: {
  target?: string;
  cwd?: string;
} = {}): { discovery: OsaDiscovery; checks: OsaDoctorCheck[] } {
  const discovery = discoverOsaProject(options);
  const checks: OsaDoctorCheck[] = [
    {
      name: "osa_project",
      ok: discovery.manifest.diagnostics.errors === 0,
      detail:
        discovery.manifest.diagnostics.errors === 0
          ? "OSA project shape is valid."
          : `${discovery.manifest.diagnostics.errors} error(s) found.`,
      fix: discovery.manifest.diagnostics.errors === 0 ? undefined : "Run miosa osa info and fix diagnostics.",
    },
    {
      name: "node_runtime",
      ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20,
      detail: `Node ${process.versions.node}`,
      fix: "Use Node 20 or newer.",
    },
    {
      name: "skills",
      ok: discovery.manifest.skills.length > 0,
      detail:
        discovery.manifest.skills.length > 0
          ? `${discovery.manifest.skills.length} skill(s) discovered.`
          : "No project skills discovered.",
      warn: discovery.manifest.skills.length === 0,
      fix: "Run miosa osa skills add browser-qa.",
    },
    {
      name: "computers",
      ok: true,
      detail:
        discovery.manifest.computers.filter((computer) => computer.enabled).length > 0
          ? "At least one Computer profile is enabled."
          : "No Computer profile enabled.",
      warn: discovery.manifest.computers.every((computer) => !computer.enabled),
      fix: "Run miosa osa computer enable.",
    },
  ];

  return { discovery, checks };
}
