import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_TAKE_KEYS,
  renderBuild,
  renderTemplate,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - plain .mjs test fixture, deliberately untyped
} from "../scripts/fake-platform-api.mjs";

/**
 * Drift detector for scripts/fake-platform-api.mjs.
 *
 * That fake replays MIOSA platform API responses transcribed BY HAND from the
 * Elixir source in the miosa-compute repo. It is what makes real end-to-end CLI
 * reproductions possible without touching production, but it is a cross-repo
 * copy with no link back: if the server changes shape, the fake keeps answering
 * the old shape, these tests keep passing, and the suite stays green while
 * reality diverges. That is a false green, one layer above the code.
 *
 * This test closes the loop by reading the real Elixir source at a named git
 * ref and asserting the fake still mirrors it, in BOTH directions - a field the
 * server adds is drift just as much as a field it removes, because a field the
 * fake does not know about is a field the CLI was never exercised against.
 *
 * It reads git objects, never the working tree, and prints the resolved commit
 * so any claim it makes is anchored to an exact revision. Point it elsewhere
 * with MIOSA_COMPUTE_PATH and MIOSA_COMPUTE_REF.
 */

/** An explicit override is used exclusively: falling back would mask a typo. */
const EXPLICIT_PATH = process.env["MIOSA_COMPUTE_PATH"];
const DEFAULT_PATHS = ["/Users/rhl/code/MIOSA/code/miosa/miosa-compute"];

/**
 * Fail rather than skip when the check cannot run. Set this wherever the
 * sibling repo IS available (a dev machine, or CI that checks out both), so an
 * unverifiable contract cannot pass quietly. An explicitly set
 * MIOSA_COMPUTE_PATH implies strict on its own: someone asked for the check.
 */
const STRICT =
  process.env["MIOSA_CONTRACT_STRICT"] === "1" || EXPLICIT_PATH !== undefined;

/** A moving ref by default: a pinned SHA could never detect future drift. */
const REF = process.env["MIOSA_COMPUTE_REF"] ?? "HEAD";

const REGISTRY_PATH = "apps/engine/lib/engine/sandbox/template_registry.ex";
const TEMPLATES_PATH = "apps/engine/lib/engine/sandbox/templates.ex";

function computeRepo(): string | null {
  const candidates =
    EXPLICIT_PATH !== undefined && EXPLICIT_PATH !== ""
      ? [EXPLICIT_PATH]
      : DEFAULT_PATHS;
  for (const candidate of candidates) {
    if (existsSync(`${candidate}/.git`)) return candidate;
  }
  return null;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

interface Source {
  readonly repo: string;
  readonly sha: string;
  readonly describe: string;
  readonly registry: string;
  readonly templates: string;
}

function loadSource(): Source | { readonly skip: string } {
  const repo = computeRepo();
  if (repo === null) {
    return {
      skip:
        `no git checkout of miosa-compute at ${
          EXPLICIT_PATH !== undefined ? EXPLICIT_PATH : DEFAULT_PATHS.join(", ")
        }. Set MIOSA_COMPUTE_PATH to point at one.`,
    };
  }
  let sha: string;
  try {
    sha = git(repo, ["rev-parse", "--verify", `${REF}^{commit}`]).trim();
  } catch (err) {
    return {
      skip:
        `cannot resolve ref ${JSON.stringify(REF)} in ${repo}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    repo,
    sha,
    describe: `${repo} @ ${REF} -> ${sha}`,
    registry: git(repo, ["show", `${sha}:${REGISTRY_PATH}`]),
    templates: git(repo, ["show", `${sha}:${TEMPLATES_PATH}`]),
  };
}

const source = loadSource();
const available = !("skip" in source);

/**
 * Field names from an Elixir map literal built inside a named function, e.g.
 * `def render_template(...) do %{ id: ..., name: ... } end`. Deliberately
 * strict: an unparseable source means the contract is UNVERIFIED, so the
 * caller fails rather than silently seeing an empty set.
 */
function mapLiteralKeys(elixir: string, functionName: string): string[] {
  const head = elixir.indexOf(`def ${functionName}(`);
  if (head === -1) {
    throw new Error(
      `CONTRACT SOURCE CHANGED: def ${functionName}/1 no longer exists. ` +
        "The fake mirrors a function that is gone; re-derive it by hand.",
    );
  }
  const open = elixir.indexOf("%{", head);
  if (open === -1) {
    throw new Error(
      `CONTRACT SOURCE CHANGED: ${functionName}/1 no longer returns a map literal.`,
    );
  }
  // Walk braces to the matching close so a nested map cannot end the scan early.
  let depth = 0;
  let end = -1;
  for (let i = open; i < elixir.length; i += 1) {
    if (elixir[i] === "{") depth += 1;
    else if (elixir[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(
      `CONTRACT SOURCE CHANGED: unbalanced map literal in ${functionName}/1.`,
    );
  }
  const body = elixir.slice(open, end);
  // Only top-level `key:` pairs, i.e. at one level of nesting inside the map.
  const keys: string[] = [];
  let nesting = 0;
  for (const line of body.split("\n")) {
    const atTopLevel = nesting <= 1;
    if (atTopLevel) {
      const match = /^\s*([a-z_][a-z0-9_]*):\s/.exec(line);
      if (match?.[1]) keys.push(match[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[") nesting += 1;
      else if (ch === "}" || ch === "]") nesting -= 1;
    }
  }
  if (keys.length === 0) {
    throw new Error(
      `CONTRACT SOURCE CHANGED: parsed no fields out of ${functionName}/1.`,
    );
  }
  return keys;
}

/** The atom list `Templates.render/1` passes to `Map.take/2`. */
function mapTakeKeys(elixir: string): string[] {
  const head = elixir.indexOf("def render(template) do");
  if (head === -1) {
    throw new Error(
      "CONTRACT SOURCE CHANGED: Templates.render/1 no longer exists.",
    );
  }
  const open = elixir.indexOf("Map.take([", head);
  if (open === -1) {
    throw new Error(
      "CONTRACT SOURCE CHANGED: Templates.render/1 no longer uses Map.take/2. " +
        "The catalog rendering that strips fields from custom rows has changed.",
    );
  }
  const close = elixir.indexOf("])", open);
  const list = elixir.slice(open + "Map.take([".length, close);
  const keys = [...list.matchAll(/:([a-z_][a-z0-9_]*)/g)]
    .map((m) => m[1])
    .filter((k): k is string => typeof k === "string");
  if (keys.length === 0) {
    throw new Error(
      "CONTRACT SOURCE CHANGED: parsed no atoms out of Templates.render/1's Map.take list.",
    );
  }
  return keys;
}

function diff(
  fakeKeys: readonly string[],
  serverKeys: readonly string[],
): { missing: string[]; extra: string[] } {
  const server = new Set(serverKeys);
  const fake = new Set(fakeKeys);
  return {
    // In the fake but not the server: the fake is answering a field the server
    // no longer sends, so the CLI is exercised against a fiction.
    extra: [...fake].filter((k) => !server.has(k)).sort(),
    // In the server but not the fake: a new field the CLI has never seen.
    missing: [...server].filter((k) => !fake.has(k)).sort(),
  };
}

describe("scripts/fake-platform-api.mjs mirrors the real server shapes", () => {
  // The instruction to "skip loudly when the repo is absent" and the rule that
  // "a skipped test reporting green is the defect" pull against each other,
  // because a vitest skip IS green. Resolved by splitting the cases:
  //
  //   repo present                  -> the checks below run for real
  //   repo absent, STRICT           -> FAIL, naming why (explicit override, or
  //                                    MIOSA_CONTRACT_STRICT=1)
  //   repo absent, not STRICT       -> skip, with the reason on stderr and in
  //                                    the test name, so a checkout that cannot
  //                                    possibly verify (CI clones only this
  //                                    repo) does not fail for it
  it("can reach a miosa-compute checkout to compare against", () => {
    if (available) {
      expect((source as Source).sha).toMatch(/^[0-9a-f]{40}$/);
      return;
    }
    const reason = (source as { skip: string }).skip;
    process.stderr.write(
      `\n[server-contract] CONTRACT NOT VERIFIED: ${reason}\n` +
        "[server-contract] The fake's shapes were NOT checked against the server on this run.\n" +
        `[server-contract] strict=${STRICT ? "yes, failing" : "no, skipping"}\n\n`,
    );
    if (STRICT) {
      expect
        .soft(
          false,
          `CONTRACT NOT VERIFIED and strict mode is on: ${reason}`,
        )
        .toBe(true);
      throw new Error(`CONTRACT NOT VERIFIED (strict): ${reason}`);
    }
  });

  it.skipIf(!available)(
    "renderTemplate mirrors TemplateRegistry.render_template/1 exactly",
    () => {
      const src = source as Source;
      process.stderr.write(`[server-contract] read ${src.describe}\n`);

      const serverKeys = mapLiteralKeys(src.registry, "render_template");
      const fakeKeys = Object.keys(
        renderTemplate() as Record<string, unknown>,
      );
      const { missing, extra } = diff(fakeKeys, serverKeys);

      expect(
        extra,
        `FAKE IS STALE (${src.describe}): scripts/fake-platform-api.mjs returns ` +
          `field(s) [${extra.join(", ")}] that TemplateRegistry.render_template/1 no ` +
          "longer sends. Remove them from renderTemplate().",
      ).toEqual([]);
      expect(
        missing,
        `FAKE IS STALE (${src.describe}): TemplateRegistry.render_template/1 now sends ` +
          `field(s) [${missing.join(", ")}] that the fake does not. The CLI has never ` +
          "been exercised against them. Add them to renderTemplate().",
      ).toEqual([]);
    },
  );

  it.skipIf(!available)(
    "renderBuild mirrors TemplateRegistry.render_build/1 exactly",
    () => {
      const src = source as Source;
      const serverKeys = mapLiteralKeys(src.registry, "render_build");
      const fakeKeys = Object.keys(renderBuild() as Record<string, unknown>);
      const { missing, extra } = diff(fakeKeys, serverKeys);

      expect(
        extra,
        `FAKE IS STALE (${src.describe}): the fake's renderBuild() returns ` +
          `[${extra.join(", ")}], which TemplateRegistry.render_build/1 no longer sends.`,
      ).toEqual([]);
      expect(
        missing,
        `FAKE IS STALE (${src.describe}): TemplateRegistry.render_build/1 now sends ` +
          `[${missing.join(", ")}], which the fake does not.`,
      ).toEqual([]);
    },
  );

  it.skipIf(!available)(
    "CATALOG_TAKE_KEYS mirrors Templates.render/1's Map.take list exactly",
    () => {
      const src = source as Source;
      const serverKeys = mapTakeKeys(src.templates);
      const { missing, extra } = diff(
        CATALOG_TAKE_KEYS as readonly string[],
        serverKeys,
      );

      // This list is the reason `templates list` cannot show a custom row's
      // slug or created date: Map.take drops them. If the server adds :slug
      // here, that CLI workaround becomes redundant and this test is how we
      // find out rather than discovering it from a customer.
      expect(
        extra,
        `FAKE IS STALE (${src.describe}): CATALOG_TAKE_KEYS keeps ` +
          `[${extra.join(", ")}], which Templates.render/1's Map.take list no longer has.`,
      ).toEqual([]);
      expect(
        missing,
        `FAKE IS STALE (${src.describe}): Templates.render/1's Map.take list now includes ` +
          `[${missing.join(", ")}]. If that includes "slug" or "inserted_at", the ` +
          "`templates list --verify` per-row read is no longer needed - see " +
          "src/commands/templates.ts.",
      ).toEqual([]);
    },
  );
});
