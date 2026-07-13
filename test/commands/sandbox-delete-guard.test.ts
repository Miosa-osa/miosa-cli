import { describe, it, expect } from "vitest";
import {
  assertDeletableRemoteDir,
  normalizeRemoteDeleteDir,
  PROTECTED_DELETE_ROOTS,
} from "../../src/commands/sandbox-delete-guard.js";
import { UserError } from "../../src/errors.js";

describe("normalizeRemoteDeleteDir", () => {
  it("strips trailing slashes", () => {
    expect(normalizeRemoteDeleteDir("/var/")).toBe("/var");
    expect(normalizeRemoteDeleteDir("/workspace/app/")).toBe("/workspace/app");
  });

  it("collapses duplicate slashes", () => {
    expect(normalizeRemoteDeleteDir("//")).toBe("/");
    expect(normalizeRemoteDeleteDir("/workspace//app/")).toBe("/workspace/app");
  });

  it("resolves dot segments", () => {
    expect(normalizeRemoteDeleteDir("/var/lib/../lib")).toBe("/var/lib");
    expect(normalizeRemoteDeleteDir("/tmp/.")).toBe("/tmp");
    expect(normalizeRemoteDeleteDir("/tmp/./")).toBe("/tmp");
  });

  it("clamps parent segments at the root", () => {
    expect(normalizeRemoteDeleteDir("/tmp/..")).toBe("/");
    expect(normalizeRemoteDeleteDir("..")).toBe("/");
  });

  it("anchors relative paths at / (sandbox exec cwd)", () => {
    expect(normalizeRemoteDeleteDir("var")).toBe("/var");
    expect(normalizeRemoteDeleteDir("workspace/app")).toBe("/workspace/app");
  });

  it("maps empty and dot inputs to /", () => {
    expect(normalizeRemoteDeleteDir("")).toBe("/");
    expect(normalizeRemoteDeleteDir(".")).toBe("/");
    expect(normalizeRemoteDeleteDir("  /  ")).toBe("/");
  });
});

describe("assertDeletableRemoteDir", () => {
  const protectedInputs = [
    "",
    "/",
    "/var",
    "/var/lib",
    "/etc",
    "/usr",
    "/home",
    "/root",
    "/tmp",
    // Sneaky spellings of the same roots.
    "//",
    "/var/",
    "var",
    "/var/lib/../lib",
    "/tmp/./",
    "/tmp/..",
  ];

  for (const input of protectedInputs) {
    it(`refuses protected path ${JSON.stringify(input)}`, () => {
      expect(() => assertDeletableRemoteDir(input)).toThrow(UserError);
      expect(() => assertDeletableRemoteDir(input)).toThrow(
        /Refusing --delete/,
      );
    });
  }

  it("returns the normalized path for safe directories", () => {
    expect(assertDeletableRemoteDir("/workspace")).toBe("/workspace");
    expect(assertDeletableRemoteDir("/workspace//app/")).toBe("/workspace/app");
    expect(assertDeletableRemoteDir("/var/lib/postgresql")).toBe(
      "/var/lib/postgresql",
    );
    expect(assertDeletableRemoteDir("/home/user")).toBe("/home/user");
  });

  it("keeps the protected root list in sync with the incident spec", () => {
    for (const root of [
      "/",
      "",
      "/var",
      "/var/lib",
      "/etc",
      "/usr",
      "/home",
      "/root",
      "/tmp",
    ]) {
      expect(PROTECTED_DELETE_ROOTS.has(root)).toBe(true);
    }
  });
});
