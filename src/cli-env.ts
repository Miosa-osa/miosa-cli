export function envTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function applyCliEnv(): void {
  if (process.argv.includes("--json")) {
    process.env["MIOSA_JSON"] = "1";
  }
  if (process.argv.includes("--debug")) {
    process.env["MIOSA_DEBUG"] = "1";
  }
  if (process.argv.includes("--quiet")) {
    process.env["MIOSA_QUIET"] = "1";
  }
  if (process.argv.includes("--no-color")) {
    process.env["MIOSA_NO_COLOR"] = "1";
  }
  if (envTruthy(process.env["MIOSA_NO_COLOR"])) {
    process.env["NO_COLOR"] = process.env["NO_COLOR"] || "1";
    process.env["FORCE_COLOR"] = "0";
  }
}

export function isJsonMode(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json) || envTruthy(process.env["MIOSA_JSON"]);
}

export function isDebugMode(opts?: { debug?: boolean }): boolean {
  return Boolean(opts?.debug) || envTruthy(process.env["MIOSA_DEBUG"]);
}

export function isQuietMode(opts?: { quiet?: boolean }): boolean {
  return Boolean(opts?.quiet) || envTruthy(process.env["MIOSA_QUIET"]);
}

applyCliEnv();
