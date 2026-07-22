import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_USER_AGENT, CLI_VERSION } from "../src/version.js";

describe("release version", () => {
  it("uses package metadata for the runtime identity", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(CLI_VERSION).toBe(manifest.version);
    expect(CLI_USER_AGENT).toBe(`@miosa/cli/${manifest.version}`);
  });
});
