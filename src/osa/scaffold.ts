import fs from "node:fs";
import path from "node:path";
import { UserError } from "../errors.js";
import { resolveTarget } from "./paths.js";

export interface InitResult {
  projectRoot: string;
  created: string[];
  skipped: string[];
}

interface ScaffoldFile {
  path: string;
  content: string;
}

const scaffoldFiles: ScaffoldFile[] = [
  {
    path: "agent/AGENTS.md",
    content: `# OSA Agent Instructions

This project defines a filesystem-first OSA agent. Keep always-needed project
context here. Put optional procedures in \`agent/skills/\`.
`,
  },
  {
    path: "agent/instructions.md",
    content: `# Identity

You are an OSA agent. Work carefully, inspect available project context, use
tools only when needed, and explain material uncertainty.

# Rules

- Use tools instead of guessing.
- Ask for approval before external side effects.
- Keep outputs concise and cite the source of important facts.
`,
  },
  {
    path: "agent/agent.ts",
    content: `import { defineAgent } from "@miosa/osa";

export default defineAgent({
  description: "Filesystem-defined OSA agent operating environment.",
  model: {
    primary: "default",
    fallback: [],
  },
  harness: {
    engine: "auto",
    allowed: ["codex", "claude-code", "hermes", "osa"],
  },
  runtime: {
    target: "miosa-cloud",
    durability: "checkpointed",
    streaming: true,
  },
  sandbox: {
    backend: "auto",
    allowed: ["miosa-computer", "miosa-sandbox", "local-docker"],
    resources: {
      cpu: 2,
      memoryGb: 4,
    },
  },
  policy: {
    network: "restricted",
    approvals: ["external_side_effects"],
  },
  capabilities: {
    shell: true,
    browser: true,
  },
});
`,
  },
  {
    path: "agent/permissions.yml",
    content: `filesystem:
  read:
    - "."
  write:
    - "./workspace"
network:
  default: deny
  allow:
    - "localhost"
secrets:
  allow: []
approvals:
  required_for:
    - "outbound_message"
    - "network:external"
`,
  },
  {
    path: "agent/sandbox/sandbox.ts",
    content: `import { defineSandbox } from "@miosa/osa/sandbox";

export default defineSandbox({
  description: "Default isolated MIOSA sandbox.",
  resources: {
    cpu: 2,
    memoryGb: 4,
  },
  workspaceSeed: "agent/sandbox/workspace",
});
`,
  },
  {
    path: "agent/sandbox/workspace/README.md",
    content: `# Workspace

Seed files copied into the agent sandbox at session start.
`,
  },
  {
    path: "agent/computers/default.yml",
    content: `enabled: false
kind: miosa-computer
size: standard
workspace:
  persist: true
network:
  default: deny
  allow:
    - "localhost"
capabilities:
  browser: true
  screenshot: true
  shell: true
  desktop: true
`,
  },
  {
    path: "agent/docs/README.md",
    content: `# OSA Project Docs

Place reference material here. Keep always-needed operating rules in
\`agent/AGENTS.md\`.
`,
  },
  {
    path: "evals/smoke.yml",
    content: `name: smoke
description: Basic scaffold smoke eval placeholder.
prompt: "Summarize what this OSA project can do."
checks:
  - type: completed
`,
  },
  {
    path: "agent/skills/getting-started.md",
    content: `---
description: Use when a user asks what this OSA project contains or how to extend it.
trust: local
---

Explain the project layout, point to \`agent/AGENTS.md\`, and recommend running
\`miosa osa info\` before changing runtime behavior.
`,
  },
  {
    path: "agent/tools/get_weather.ts",
    content: `import { defineTool } from "@miosa/osa/tools";

export default defineTool({
  description: "Return mocked weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
`,
  },
  {
    path: "agent/channels/slack.ts",
    content: `import { defineChannel } from "@miosa/osa/channels";

export default defineChannel({
  description: "Slack surface for OSA agent messages.",
  type: "slack",
});
`,
  },
  {
    path: "agent/connections/linear.ts",
    content: `import { defineConnection } from "@miosa/osa/connections";

export default defineConnection({
  description: "Linear connection for issue follow-up.",
  type: "linear",
  auth: {
    mode: "env",
    variable: "LINEAR_API_KEY",
  },
});
`,
  },
  {
    path: "agent/subagents/researcher/agent.ts",
    content: `import { defineAgent } from "@miosa/osa";

export default defineAgent({
  description: "Researches unfamiliar topics and returns evidence.",
  model: {
    primary: "default",
  },
  harness: {
    engine: "auto",
  },
});
`,
  },
  {
    path: "agent/subagents/researcher/instructions.md",
    content: `Find relevant evidence, separate facts from uncertainty, and return concise
notes to the parent agent. Do not make final user-facing decisions.
`,
  },
  {
    path: "agent/schedules/daily-report.md",
    content: `---
cron: "0 8 * * *"
---

Prepare a daily OSA project status report and list blocked follow-ups.
`,
  },
];

export function initOsaProject(options: {
  target?: string;
  cwd?: string;
  force?: boolean;
}): InitResult {
  const projectRoot = resolveTarget(options.target, options.cwd);
  const created: string[] = [];
  const skipped: string[] = [];

  fs.mkdirSync(projectRoot, { recursive: true });

  for (const file of scaffoldFiles) {
    const fullPath = path.join(projectRoot, file.path);
    const exists = fs.existsSync(fullPath);
    if (exists && !options.force) {
      skipped.push(file.path);
      continue;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, "utf8");
    created.push(file.path);
  }

  if (created.length === 0 && skipped.length > 0 && !options.force) {
    throw new UserError(
      "OSA project files already exist.",
      "Pass --force to overwrite scaffolded OSA files.",
    );
  }

  return { projectRoot, created, skipped };
}
