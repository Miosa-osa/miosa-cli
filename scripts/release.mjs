#!/usr/bin/env node
// Derived, one-step semantic versioning for an npm package.
//
// The version number is never typed by a person or an agent.
// It is computed from the conventional-commit history since the last release:
//   any `!` or "BREAKING CHANGE" footer  -> major
//   any `feat`                           -> minor
//   anything else                        -> patch
// The result is always exactly one step above the version currently published
// on npm, so numbers can neither jump nor skip.
//
// Usage:
//   node scripts/release.mjs --dry-run                 show the next version and changelog section
//   node scripts/release.mjs --apply                   write package.json, CHANGELOG.md, commit, tag
//   node scripts/release.mjs --check --base origin/main  CI policy: fail on hand-edited versions
//   node scripts/release.mjs --backfill --apply        add the missing changelog section for the current version
//
// Options:
//   --package-dir <dir>   package root (default ".")
//   --tag-prefix <str>    tag prefix (default "v"; monorepos use e.g. "sdks/typescript/v")
//   --skip-npm-check      do not compare package.json against the npm registry (offline CI)
//
// Pure helpers are exported for tests; `main()` runs only when executed directly.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const CONVENTIONAL = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/;
const SKIP_SUBJECTS = [/^Merge /, /^chore\(release\)/, /^release: /];

export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim());
  if (!m) throw new Error(`not a release version: ${text}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function bump(version, level) {
  const v = parseVersion(version);
  if (level === "major") return formatVersion({ major: v.major + 1, minor: 0, patch: 0 });
  if (level === "minor") return formatVersion({ major: v.major, minor: v.minor + 1, patch: 0 });
  if (level === "patch") return formatVersion({ ...v, patch: v.patch + 1 });
  throw new Error(`unknown bump level: ${level}`);
}

// Classify one commit. Returns null for commits that carry no release signal
// (merges, previous release commits).
export function classifyCommit(subject, body = "") {
  if (SKIP_SUBJECTS.some((re) => re.test(subject))) return null;
  const m = CONVENTIONAL.exec(subject);
  const breaking = (m && m[3] === "!") || /^BREAKING[ -]CHANGE:/m.test(body);
  if (!m) {
    return { type: "other", breaking, subject, section: "Changed", conventional: false };
  }
  const type = m[1].toLowerCase();
  const section = type === "feat" ? "Added" : type === "fix" ? "Fixed" : "Changed";
  return { type, breaking, subject: m[4].trim(), section, conventional: true };
}

export function bumpLevel(entries) {
  if (entries.some((e) => e.breaking)) return "major";
  if (entries.some((e) => e.type === "feat")) return "minor";
  return "patch";
}

export function renderSection(version, date, entries) {
  const groups = { Added: [], Fixed: [], Changed: [] };
  for (const e of entries) groups[e.section].push(e.subject);
  const lines = [`## [${version}] - ${date}`, ""];
  for (const name of ["Added", "Fixed", "Changed"]) {
    if (groups[name].length === 0) continue;
    lines.push(`### ${name}`);
    for (const s of groups[name]) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Insert a section directly under the first "# Changelog" heading, before any
// existing "## [" section. Prose between the heading and the first section is
// preserved above the new entry.
export function insertSection(changelog, section) {
  const lines = changelog.split("\n");
  const firstSection = lines.findIndex((l) => l.startsWith("## ["));
  if (firstSection === -1) return `${changelog.trimEnd()}\n\n${section}\n`;
  return [...lines.slice(0, firstSection), section, ...lines.slice(firstSection)].join("\n");
}

export function topChangelogVersion(changelog) {
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const opts = {
    packageDir: ".",
    tagPrefix: "v",
    base: null,
    dryRun: false,
    apply: false,
    check: false,
    backfill: false,
    skipNpmCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--package-dir") opts.packageDir = argv[++i];
    else if (a === "--tag-prefix") opts.tagPrefix = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--apply") opts.apply = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--backfill") opts.backfill = true;
    else if (a === "--skip-npm-check") opts.skipNpmCheck = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.dryRun && !opts.apply && !opts.check) opts.dryRun = true;
  return opts;
}

function readPackage(pkgDir) {
  const path = join(pkgDir, "package.json");
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
}

function commitsBetween(repoRoot, from, to, pathspec) {
  const range = from ? `${from}..${to}` : to;
  const args = ["log", "--format=%H%x1f%s%x1f%b%x1e", range];
  if (pathspec) args.push("--", pathspec);
  const out = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, body] = rec.split("\x1f");
      return { sha, subject: subject.trim(), body: (body || "").trim() };
    });
}

function tagExists(repoRoot, tag) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function npmLatest(name) {
  return execFileSync("npm", ["view", name, "version"], { encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The commit that last set package.json to the current version. Used when the
// release tag was never pushed, so a missing tag cannot widen the scan to the
// whole history and inflate the bump.
function versionCommit(repoRoot, pkgDir, version) {
  const relPkg = join(pkgDir, "package.json").replace(/^\.\//, "");
  const out = git(
    ["log", "-1", "--format=%H", `-S"version": "${version}"`, "--", relPkg],
    repoRoot,
  );
  return out || null;
}

function computeNext(repoRoot, pkgDir, pkg, opts) {
  const current = pkg.json.version;
  const currentTag = `${opts.tagPrefix}${current}`;
  let from = tagExists(repoRoot, currentTag) ? currentTag : null;
  if (!from) {
    from = versionCommit(repoRoot, pkgDir, current);
    console.error(
      `release: warning: tag ${currentTag} not found; scanning since ` +
        (from ? `the commit that set ${current} (${from.slice(0, 9)})` : `the start of history`),
    );
  }
  const pathspec = resolve(pkgDir) === resolve(repoRoot) ? null : pkgDir;
  const commits = commitsBetween(repoRoot, from, "HEAD", pathspec);
  const entries = commits
    .map((c) => classifyCommit(c.subject, c.body))
    .filter(Boolean);
  const level = bumpLevel(entries);
  return { current, currentTag, commits, entries, level, next: bump(current, level) };
}

function runRelease(repoRoot, pkgDir, opts) {
  const pkg = readPackage(pkgDir);
  if (opts.apply && git(["status", "--porcelain"], repoRoot) !== "") {
    fail("working tree is not clean; commit or discard changes before --apply");
  }
  if (!opts.skipNpmCheck) {
    const published = npmLatest(pkg.json.name);
    if (published !== pkg.json.version) {
      fail(
        `package.json says ${pkg.json.version} but npm latest is ${published}; ` +
          `reconcile the registry and the tag before cutting a new release`,
      );
    }
  }
  const plan = computeNext(repoRoot, pkgDir, pkg, opts);
  if (plan.entries.length === 0) fail(`no releasable commits since ${plan.currentTag}`);
  const nonConventional = plan.entries.filter((e) => !e.conventional);
  const section = renderSection(plan.next, today(), plan.entries);

  console.log(`package:   ${pkg.json.name}`);
  console.log(`current:   ${plan.current} (${plan.currentTag})`);
  console.log(`commits:   ${plan.commits.length} scanned, ${plan.entries.length} releasable`);
  console.log(`bump:      ${plan.level}`);
  console.log(`next:      ${plan.next} (${opts.tagPrefix}${plan.next})`);
  if (nonConventional.length > 0) {
    console.log(`warning:   ${nonConventional.length} commit(s) without a conventional subject counted as patch`);
  }
  console.log("");
  console.log(section);

  if (!opts.apply) return;

  const changelogPath = join(pkgDir, "CHANGELOG.md");
  const changelog = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "# Changelog\n\nAll notable changes to this package are documented in this file.\nThis file is generated by scripts/release.mjs; do not edit it by hand.\n\n";
  writeFileSync(changelogPath, insertSection(changelog, section));
  pkg.json.version = plan.next;
  writeFileSync(pkg.path, `${JSON.stringify(pkg.json, null, 2)}\n`);
  const lockPath = join(pkgDir, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = plan.next;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = plan.next;
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
  const tag = `${opts.tagPrefix}${plan.next}`;
  git(["add", "--", pkg.path, changelogPath, ...(existsSync(lockPath) ? [lockPath] : [])], repoRoot);
  git(["commit", "-q", "-m", `chore(release): ${pkg.json.name} ${plan.next}`], repoRoot);
  git(["tag", "-a", tag, "-m", `${pkg.json.name} ${plan.next}`], repoRoot);
  console.log(`\ncommitted and tagged ${tag}. Push the branch and the tag to publish.`);
}

function runBackfill(repoRoot, pkgDir, opts) {
  const pkg = readPackage(pkgDir);
  const changelogPath = join(pkgDir, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\n";
  const current = pkg.json.version;
  if (topChangelogVersion(changelog) === current) {
    console.log(`changelog already has ${current}; nothing to backfill`);
    return;
  }
  const currentTag = `${opts.tagPrefix}${current}`;
  if (!tagExists(repoRoot, currentTag)) fail(`cannot backfill: tag ${currentTag} does not exist`);
  const previous = topChangelogVersion(changelog);
  const previousTag = previous ? `${opts.tagPrefix}${previous}` : null;
  const from = previousTag && tagExists(repoRoot, previousTag) ? previousTag : null;
  const pathspec = resolve(pkgDir) === resolve(repoRoot) ? null : pkgDir;
  const entries = commitsBetween(repoRoot, from, currentTag, pathspec)
    .map((c) => classifyCommit(c.subject, c.body))
    .filter(Boolean);
  const date = git(["log", "-1", "--format=%cs", currentTag], repoRoot);
  const section = renderSection(current, date, entries);
  console.log(section);
  if (!opts.apply) return;
  writeFileSync(changelogPath, insertSection(changelog, section));
  console.log(`\nwrote ${changelogPath} section for ${current}; review and commit it as chore(release): changelog backfill`);
}

// CI policy. Compares HEAD against --base:
//   * version unchanged  -> pass (and the changelog top must not claim a newer version)
//   * version changed    -> HEAD commit must be a release commit, the new version must
//                           equal base version bumped one step by the commits in between,
//                           and the changelog top must be the new version.
function runCheck(repoRoot, pkgDir, opts) {
  if (!opts.base) fail("--check requires --base <ref>");
  const pkg = readPackage(pkgDir);
  const relPkg = join(pkgDir, "package.json").replace(/^\.\//, "");
  const baseJson = JSON.parse(git(["show", `${opts.base}:${relPkg}`], repoRoot));
  const changelogPath = join(pkgDir, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const top = topChangelogVersion(changelog);

  if (baseJson.version === pkg.json.version) {
    if (top && top !== pkg.json.version && parseVersion(top) && compare(top, pkg.json.version) > 0) {
      fail(`CHANGELOG.md top section ${top} is ahead of package.json ${pkg.json.version}`);
    }
    console.log(`version policy: ${pkg.json.version} unchanged, ok`);
    return;
  }

  const headSubject = git(["log", "-1", "--format=%s", "HEAD"], repoRoot);
  if (!/^chore\(release\): /.test(headSubject)) {
    fail(
      `package.json version changed ${baseJson.version} -> ${pkg.json.version} outside a release commit ` +
        `(HEAD is "${headSubject}"). Run node scripts/release.mjs --apply instead of editing the version.`,
    );
  }
  const pathspec = resolve(pkgDir) === resolve(repoRoot) ? null : pkgDir;
  const entries = commitsBetween(repoRoot, opts.base, "HEAD", pathspec)
    .map((c) => classifyCommit(c.subject, c.body))
    .filter(Boolean);
  const expected = bump(baseJson.version, bumpLevel(entries));
  if (expected !== pkg.json.version) {
    fail(
      `version ${pkg.json.version} is not the derived next version ${expected} ` +
        `(base ${baseJson.version}, level ${bumpLevel(entries)} from ${entries.length} commit(s))`,
    );
  }
  if (top !== pkg.json.version) {
    fail(`CHANGELOG.md top section is ${top}, expected ${pkg.json.version}`);
  }
  console.log(`version policy: ${baseJson.version} -> ${pkg.json.version} derived correctly, ok`);
}

export function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const pkgDir = opts.packageDir;
  const repoRoot = git(["rev-parse", "--show-toplevel"], pkgDir);
  if (opts.check) return runCheck(repoRoot, pkgDir, opts);
  if (opts.backfill) return runBackfill(repoRoot, pkgDir, opts);
  return runRelease(repoRoot, pkgDir, opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
