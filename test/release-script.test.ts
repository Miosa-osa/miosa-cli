import { describe, expect, it } from "vitest";

import {
  bump,
  bumpLevel,
  classifyCommit,
  compare,
  insertSection,
  parseVersion,
  renderSection,
  topChangelogVersion,
} from "../scripts/release.mjs";

describe("release script: version derivation", () => {
  it("should bump exactly one step per level", () => {
    expect(bump("1.3.4", "patch")).toBe("1.3.5");
    expect(bump("1.3.4", "minor")).toBe("1.4.0");
    expect(bump("1.3.4", "major")).toBe("2.0.0");
  });

  it("should reject non-release versions", () => {
    expect(() => parseVersion("1.3")).toThrow();
    expect(() => parseVersion("1.3.4-beta.1")).toThrow();
    expect(() => bump("1.3.4", "huge")).toThrow();
  });

  it("should derive patch when only fixes and chores landed", () => {
    const entries = [
      classifyCommit("fix(cli): mark server failures retryable"),
      classifyCommit("chore: bump deps"),
      classifyCommit("docs: explain retries"),
    ];
    expect(bumpLevel(entries)).toBe("patch");
  });

  it("should derive minor when any feat landed", () => {
    const entries = [
      classifyCommit("fix(cli): something"),
      classifyCommit("feat(sandbox): custom disk sizing (#91)"),
    ];
    expect(bumpLevel(entries)).toBe("minor");
  });

  it("should derive major on a bang or a BREAKING CHANGE footer", () => {
    expect(bumpLevel([classifyCommit("feat(api)!: drop v0 routes")])).toBe("major");
    expect(
      bumpLevel([classifyCommit("fix(auth): rotate tokens", "BREAKING CHANGE: tokens expire")]),
    ).toBe("major");
  });

  it("should never skip a number: two feats and three fixes are still one minor", () => {
    const entries = [
      classifyCommit("feat: a"),
      classifyCommit("feat: b"),
      classifyCommit("fix: c"),
      classifyCommit("fix: d"),
      classifyCommit("fix: e"),
    ];
    expect(bump("1.1.22", bumpLevel(entries))).toBe("1.2.0");
  });

  it("should ignore merge and previous release commits", () => {
    expect(classifyCommit("Merge pull request #104 from Miosa-osa/release/cli-1.3.4")).toBeNull();
    expect(classifyCommit("chore(release): @miosa/cli 1.3.4")).toBeNull();
    expect(classifyCommit("release: @miosa/cli 1.3.4")).toBeNull();
  });

  it("should count a non-conventional subject as a flagged patch entry", () => {
    const entry = classifyCommit("tidy up the readme");
    expect(entry).toMatchObject({ conventional: false, section: "Changed", breaking: false });
    expect(bumpLevel([entry!])).toBe("patch");
  });

  it("should compare versions numerically", () => {
    expect(compare("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compare("1.3.4", "1.3.4")).toBe(0);
  });
});

describe("release script: changelog rendering", () => {
  it("should group entries under Added, Fixed and Changed", () => {
    const section = renderSection("1.3.5", "2026-09-05", [
      classifyCommit("fix(cli): mark server failures retryable (#103)")!,
      classifyCommit("feat(cli): add --json to doctor")!,
      classifyCommit("refactor(cli): split http client")!,
    ]);
    expect(section).toContain("## [1.3.5] - 2026-09-05");
    expect(section.indexOf("### Added")).toBeLessThan(section.indexOf("### Fixed"));
    expect(section.indexOf("### Fixed")).toBeLessThan(section.indexOf("### Changed"));
    expect(section).toContain("- mark server failures retryable (#103)");
    expect(section).toContain("- add --json to doctor");
    expect(section).toContain("- split http client");
  });

  it("should insert the new section above the previous top section and keep the header", () => {
    const changelog = "# Changelog\n\nAll notable changes.\n\n## [1.3.4] - 2026-09-04\n\n### Fixed\n- old\n";
    const updated = insertSection(changelog, "## [1.3.5] - 2026-09-05\n\n### Fixed\n- new\n");
    expect(topChangelogVersion(updated)).toBe("1.3.5");
    expect(updated.indexOf("All notable changes.")).toBeLessThan(updated.indexOf("## [1.3.5]"));
    expect(updated.indexOf("## [1.3.5]")).toBeLessThan(updated.indexOf("## [1.3.4]"));
  });

  it("should append when the changelog has no sections yet", () => {
    const updated = insertSection("# Changelog\n", "## [0.1.0] - 2026-09-05\n\n### Added\n- first\n");
    expect(topChangelogVersion(updated)).toBe("0.1.0");
  });
});
