import type { OsaSkill } from "./types.js";

export interface BuiltinSkill extends OsaSkill {
  content: string;
}

export const builtinSkills: BuiltinSkill[] = [
  {
    name: "browser-qa",
    path: "builtin/browser-qa/SKILL.md",
    source: "builtin",
    trust: "builtin",
    description: "Use when validating a browser workflow, visual state, or regression.",
    permissions: ["browser", "screenshot", "network:localhost"],
    content: `---
name: browser-qa
description: Use when validating a browser workflow, visual state, or regression.
trust: builtin
permissions:
  tools:
    - browser
    - screenshot
  network:
    - "localhost"
---

Inspect the target UI, exercise the critical path, capture evidence, and report concrete failures with reproduction steps.
`,
  },
  {
    name: "code-review",
    path: "builtin/code-review/SKILL.md",
    source: "builtin",
    trust: "builtin",
    description: "Use when reviewing code changes for bugs, regressions, and missing tests.",
    permissions: ["filesystem:read"],
    content: `---
name: code-review
description: Use when reviewing code changes for bugs, regressions, and missing tests.
trust: builtin
permissions:
  tools:
    - read_file
---

Prioritize correctness risks, production regressions, missing edge-case handling, and missing tests. Cite exact files and lines.
`,
  },
  {
    name: "release-checklist",
    path: "builtin/release-checklist/SKILL.md",
    source: "builtin",
    trust: "builtin",
    description: "Use when preparing a release checklist, verification plan, or launch handoff.",
    permissions: ["filesystem:read"],
    content: `---
name: release-checklist
description: Use when preparing a release checklist, verification plan, or launch handoff.
trust: builtin
permissions:
  tools:
    - read_file
---

Create a narrow release checklist covering build, tests, smoke checks, rollback, monitoring, and owner handoff.
`,
  },
  {
    name: "support-triage",
    path: "builtin/support-triage/SKILL.md",
    source: "builtin",
    trust: "builtin",
    description: "Use when triaging customer support issues into severity, owner, and next action.",
    permissions: ["filesystem:read"],
    content: `---
name: support-triage
description: Use when triaging customer support issues into severity, owner, and next action.
trust: builtin
permissions:
  tools:
    - read_file
---

Classify the issue, identify missing facts, propose the next action, and separate user impact from internal implementation detail.
`,
  },
];

export function findBuiltinSkill(name: string): BuiltinSkill | undefined {
  return builtinSkills.find((skill) => skill.name === name);
}
