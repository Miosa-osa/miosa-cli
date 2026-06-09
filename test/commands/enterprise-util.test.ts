import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseData } from "../../src/commands/enterprise-util.js";

describe("enterprise resource input parsing", () => {
  it("parses inline JSON from --data", () => {
    expect(parseData('{"name":"app"}')).toEqual({ name: "app" });
  });

  it("parses inline YAML from --input", () => {
    expect(parseData(undefined, "name: app\nreplicas: 2\n")).toEqual({
      name: "app",
      replicas: 2,
    });
  });

  it("parses YAML files from --file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miosa-input-"));
    const file = path.join(dir, "resource.yml");
    try {
      fs.writeFileSync(file, "name: app\nport: 3000\n");
      expect(parseData(undefined, undefined, file)).toEqual({
        name: "app",
        port: 3000,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects multiple body sources", () => {
    expect(() => parseData("{}", "name: app")).toThrow(
      /only one of --data, --input, or --file/,
    );
  });
});
