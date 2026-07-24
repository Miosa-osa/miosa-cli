import { describe, expect, it } from "vitest";
import { ACTION_CAPABILITY_IDENTITIES } from "../src/generated/action-capabilities.js";

describe("generated action capability identity contract", () => {
  it("is sorted, unique, portable, and cross-language stable", async () => {
    const { createHash } = await import("node:crypto");
    const names = ACTION_CAPABILITY_IDENTITIES.map((entry) => entry.name);

    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    for (const entry of ACTION_CAPABILITY_IDENTITIES) {
      expect(entry.name).toMatch(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
      expect(entry.version).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      const digest = createHash("sha256")
        .update(`miosa-capability/${entry.name}@${entry.version}`)
        .digest("hex");
      expect(entry.fingerprint).toBe(`sha256:${digest}`);
    }
  });
});
