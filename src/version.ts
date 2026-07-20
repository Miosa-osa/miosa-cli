import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const CLI_VERSION = manifest.version;
export const CLI_USER_AGENT = `@miosa/cli/${CLI_VERSION}`;
