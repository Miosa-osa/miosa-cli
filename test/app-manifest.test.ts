import { describe, expect, it } from "vitest";

import {
  manifestDomain,
  manifestResources,
  parseAppManifest,
} from "../src/app-manifest.js";

describe("app manifest", () => {
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
