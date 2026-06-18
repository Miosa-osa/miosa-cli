import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveTarget, sourceRoot } from "./paths.js";

export function enableComputer(options: {
  name?: string;
  target?: string;
  cwd?: string;
}): { name: string; path: string; updated: boolean } {
  const name = options.name ?? "default";
  const projectRoot = resolveTarget(options.target, options.cwd);
  const computersRoot = path.join(sourceRoot(projectRoot), "computers");
  const filePath = path.join(computersRoot, `${name}.yml`);
  const existed = fs.existsSync(filePath);

  let config: Record<string, unknown> = {};
  if (existed) {
    const parsed = YAML.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  }

  config["enabled"] = true;
  config["kind"] = typeof config["kind"] === "string" ? config["kind"] : "miosa-computer";
  config["size"] = typeof config["size"] === "string" ? config["size"] : "standard";
  config["workspace"] =
    config["workspace"] && typeof config["workspace"] === "object"
      ? config["workspace"]
      : { persist: true };
  config["network"] =
    config["network"] && typeof config["network"] === "object"
      ? config["network"]
      : { default: "deny", allow: ["localhost"] };
  config["capabilities"] =
    config["capabilities"] && typeof config["capabilities"] === "object"
      ? config["capabilities"]
      : { browser: true, screenshot: true, shell: true, desktop: true };

  fs.mkdirSync(computersRoot, { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(config), "utf8");

  return { name, path: filePath, updated: existed };
}
