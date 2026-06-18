import fs from "node:fs";
import path from "node:path";
import { UserError } from "../errors.js";
import { resolveTarget, sourceRoot } from "./paths.js";

export function addConnection(options: {
  kind: "mcp" | "openapi" | "linear" | "github" | "http";
  name?: string;
  target?: string;
  cwd?: string;
  url?: string;
  spec?: string;
  description?: string;
  auth?: "none" | "env" | "oauth";
  force?: boolean;
}): { name: string; path: string; created: boolean } {
  const name = options.name ?? options.kind;
  const projectRoot = resolveTarget(options.target, options.cwd);
  const filePath = path.join(sourceRoot(projectRoot), "connections", `${name}.ts`);
  if (fs.existsSync(filePath) && !options.force) {
    throw new UserError(`OSA connection already exists: ${name}`, "Pass --force to overwrite it.");
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, connectionSource({ ...options, name }), "utf8");
  return { name, path: filePath, created: true };
}

export function addChannel(options: {
  kind: "web" | "slack" | "github" | "api";
  name?: string;
  target?: string;
  cwd?: string;
  description?: string;
  force?: boolean;
}): { name: string; path: string; created: boolean } {
  const name = options.name ?? options.kind;
  const projectRoot = resolveTarget(options.target, options.cwd);
  const filePath = path.join(sourceRoot(projectRoot), "channels", `${name}.ts`);
  if (fs.existsSync(filePath) && !options.force) {
    throw new UserError(`OSA channel already exists: ${name}`, "Pass --force to overwrite it.");
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, channelSource({ ...options, name }), "utf8");
  return { name, path: filePath, created: true };
}

function connectionSource(options: {
  kind: "mcp" | "openapi" | "linear" | "github" | "http";
  name: string;
  url?: string;
  spec?: string;
  description?: string;
  auth?: "none" | "env" | "oauth";
}): string {
  const description = options.description ?? `${options.name} ${options.kind} connection.`;
  const auth = authBlock(options.name, options.auth);
  const extra =
    options.kind === "openapi"
      ? `,\n  spec: ${JSON.stringify(options.spec ?? "./docs/openapi.json")}`
      : options.url
        ? `,\n  url: ${JSON.stringify(options.url)}`
        : "";

  return `import { defineConnection } from "@miosa/osa/connections";

export default defineConnection({
  description: ${JSON.stringify(description)},
  type: ${JSON.stringify(options.kind)}${extra}${auth},
});
`;
}

function channelSource(options: {
  kind: "web" | "slack" | "github" | "api";
  name: string;
  description?: string;
}): string {
  const description = options.description ?? `${options.name} ${options.kind} channel.`;
  const entrypoint = options.kind === "web" || options.kind === "api"
    ? `,\n  entrypoint: ${JSON.stringify(`/api/${options.name}`)}`
    : "";
  return `import { defineChannel } from "@miosa/osa/channels";

export default defineChannel({
  description: ${JSON.stringify(description)},
  type: ${JSON.stringify(options.kind)}${entrypoint},
});
`;
}

function authBlock(name: string, auth?: "none" | "env" | "oauth"): string {
  if (auth === "env") {
    return `,\n  auth: {\n    mode: "env",\n    variable: ${JSON.stringify(`${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`)},\n  }`;
  }
  if (auth === "oauth") {
    return `,\n  auth: {\n    mode: "oauth",\n    provider: ${JSON.stringify(name)},\n  }`;
  }
  return "";
}
