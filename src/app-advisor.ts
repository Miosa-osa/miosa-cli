import fs from "node:fs";
import path from "node:path";
import {
  detectFramework,
  detectFrameworkAll,
  FRAMEWORK_LABELS,
  type DetectionResult,
  type Framework,
} from "./framework-detector.js";
import {
  loadAppManifest,
  manifestBuildCommand,
  manifestOutputPath,
  manifestPort,
  manifestProbePath,
  manifestRunCommand,
  manifestStartCommand,
  type LoadedAppManifest,
} from "./app-manifest.js";

export type AppGoal = "preview" | "deploy" | "docker-deploy";

export interface AppInspectResult {
  path: string;
  manifest: {
    path: string;
    data: LoadedAppManifest["manifest"];
  } | null;
  framework: {
    id: Framework | "unknown";
    label: string;
    confidence: number;
    alternatives: Array<{
      id: Framework;
      label: string;
      confidence: number;
    }>;
    files_examined: string[];
  };
  package_manager: string | null;
  dockerfile: string | null;
  commands: {
    install: string | false | null;
    dev: string | null;
    build: string | null;
    start: string | null;
  };
  runtime: {
    port: number | null;
    probe_path: string;
    output_path: string | null;
    needs_database: boolean;
    env_keys: string[];
  };
  recommendation: {
    template: string;
    deployment: "docker_deploy" | "standard_deploy" | "static_publish";
    reason: string;
  };
  risks: string[];
  next: string[];
}

export interface AppPlanStep {
  id: string;
  command: string;
  purpose: string;
  json: boolean;
  wait?: boolean;
  destructive?: boolean;
  optional?: boolean;
}

export interface AppPlanResult {
  goal: AppGoal;
  recommended_deploy: "docker_deploy" | "standard_deploy" | "static_publish";
  template: string;
  port: number | null;
  probe_path: string;
  build_command: string | null;
  run_command: string | null;
  output_path: string | null;
  requires: {
    database: boolean;
    env_keys: string[];
  };
  steps: AppPlanStep[];
  edge_cases: Array<{
    code: string;
    meaning: string;
    recovery: string[];
  }>;
}

const DEFAULT_PROBE_PATH = "/";

export function inspectApp(inputDir: string): AppInspectResult {
  const dir = path.resolve(inputDir);
  const manifest = loadAppManifest(dir);
  const best = detectFramework(dir);
  const all = detectFrameworkAll(dir);
  const frameworkId = manifest?.manifest.framework ?? best?.framework ?? "unknown";
  const label =
    frameworkId === "unknown"
      ? "Unknown"
      : FRAMEWORK_LABELS[frameworkId as Framework] ?? frameworkId;
  const packageManager = detectPackageManager(dir);
  const dockerfile = findDockerfile(dir);
  const envKeys = detectEnvKeys(dir, best, manifest);
  const needsDatabase = envKeys.includes("DATABASE_URL") || packageHintsDatabase(dir);
  const port = manifestPort(manifest?.manifest) ?? best?.port ?? null;
  const outputPath =
    manifestOutputPath(manifest?.manifest) ?? defaultOutputPath(best?.framework);
  const buildCommand =
    manifestBuildCommand(manifest?.manifest) ||
    packageScriptCommand(dir, packageManager, "build") ||
    best?.buildCommand ||
    null;
  const devCommand =
    manifestStartCommand(manifest?.manifest) ||
    packageScriptCommand(
      dir,
      packageManager,
      "dev",
      devScriptArgs(best?.framework, port),
    ) ||
    defaultDevCommand(best?.framework, port);
  const runCommand =
    manifestRunCommand(manifest?.manifest) ||
    packageScriptCommand(dir, packageManager, "start") ||
    best?.runCommand ||
    null;
  const installCommand = manifest?.manifest.install ?? defaultInstallCommand(dir, packageManager);
  const deployment = recommendDeployment(best, outputPath, needsDatabase, dockerfile);
  const template = manifest?.manifest.template || templateFor(frameworkId, needsDatabase);
  const risks = detectRisks(dir, best, port, runCommand, needsDatabase, dockerfile);

  return {
    path: dir,
    manifest: manifest ? { path: manifest.path, data: manifest.manifest } : null,
    framework: {
      id: frameworkId as Framework | "unknown",
      label,
      confidence: manifest?.manifest.framework ? 100 : best?.confidence ?? 0,
      alternatives: all.slice(0, 4).map((result) => ({
        id: result.framework,
        label: FRAMEWORK_LABELS[result.framework],
        confidence: result.confidence,
      })),
      files_examined: best?.filesExamined ?? [],
    },
    package_manager: packageManager,
    dockerfile,
    commands: {
      install: installCommand,
      dev: devCommand,
      build: buildCommand,
      start: runCommand,
    },
    runtime: {
      port,
      probe_path: manifestProbePath(manifest?.manifest) ?? DEFAULT_PROBE_PATH,
      output_path: outputPath,
      needs_database: needsDatabase,
      env_keys: envKeys,
    },
    recommendation: {
      template,
      deployment,
      reason: recommendationReason(deployment, best?.framework, needsDatabase),
    },
    risks,
    next: [
      `miosa app plan ${shellPath(dir)} --goal deploy --json`,
      "miosa capabilities --json",
    ],
  };
}

export function planApp(
  inputDir: string,
  options: {
    goal?: AppGoal;
    slug?: string;
    workspace?: string;
    preferDockerDeploy?: boolean;
  } = {},
): AppPlanResult {
  const inspect = inspectApp(inputDir);
  const goal = options.goal ?? "deploy";
  const slug = options.slug ?? "<slug>";
  const workspaceFlag = options.workspace ? ` --workspace ${options.workspace}` : "";
  const port = inspect.runtime.port ?? 3000;
  const probePath = inspect.runtime.probe_path;
  const buildCommand = inspect.commands.build;
  const runCommand = inspect.commands.start;
  const recommendedDeploy =
    options.preferDockerDeploy === false
      ? "standard_deploy"
      : goal === "docker-deploy"
        ? "docker_deploy"
        : inspect.recommendation.deployment;
  const steps: AppPlanStep[] = [
    {
      id: "auth_health",
      command: "miosa whoami --json",
      purpose: "Verify the current API key is live before spending build time.",
      json: true,
    },
    {
      id: "inspect",
      command: `miosa app inspect ${shellPath(inspect.path)} --json`,
      purpose: "Persist the detected framework, commands, port, env, and risks.",
      json: true,
    },
  ];

  if (inspect.runtime.needs_database) {
    steps.push({
      id: "database_create",
      command: `miosa databases create --engine postgres --wait --timeout 300 --json${workspaceFlag}`,
      purpose:
        "Create or select managed Postgres before preview/publish so DATABASE_URL can be injected.",
      json: true,
      wait: true,
    });
  }

  steps.push(
    {
      id: "sandbox_deploy",
      command: sandboxDeployCommand(inspect, port, probePath),
      purpose:
        "Upload the app to a sandbox, start it, expose the port, and wait for external preview readiness.",
      json: true,
      wait: true,
    },
    {
      id: "preview_doctor",
      command: `miosa sandbox doctor <sandbox-id> --port ${port} --probe-path ${quote(probePath)} --json`,
      purpose:
        "Verify sandbox state, internal HTTP, public route, TLS, and edge probe before publishing.",
      json: true,
    },
  );

  if (inspect.runtime.needs_database) {
    steps.push({
      id: "database_attach",
      command: "miosa sandbox db attach <sandbox-id> <db-id> --json",
      purpose:
        "Attach DATABASE_URL through encrypted sandbox env rather than writing secrets into files.",
      json: true,
    });
  }

  if (goal !== "preview") {
    steps.push({
      id: "publish",
      command: publishCommand(
        recommendedDeploy,
        slug,
        buildCommand,
        runCommand,
        port,
        inspect.runtime.output_path,
      ),
      purpose:
        recommendedDeploy === "docker_deploy"
          ? "Promote the sandbox workspace into the recommended App Engine production runtime."
          : "Promote the sandbox workspace into durable MIOSA app hosting.",
      json: true,
      wait: true,
    });
    steps.push({
      id: "production_probe",
      command:
        recommendedDeploy === "docker_deploy"
          ? `miosa docker-deploy doctor <deployment-id> --probe-path ${quote(probePath)} --json`
          : "curl -fsS <production-url>",
      purpose:
        recommendedDeploy === "docker_deploy"
          ? "Verify deployment_product, App Engine host health, appliance route metadata, and the public URL in one agent-readable check."
          : "Probe the returned production URL. Do not mark complete from control-plane state alone.",
      json: recommendedDeploy === "docker_deploy",
    });
  }

  return {
    goal,
    recommended_deploy: recommendedDeploy,
    template: inspect.recommendation.template,
    port: inspect.runtime.port,
    probe_path: probePath,
    build_command: buildCommand,
    run_command: runCommand,
    output_path: inspect.runtime.output_path,
    requires: {
      database: inspect.runtime.needs_database,
      env_keys: inspect.runtime.env_keys,
    },
    steps,
    edge_cases: edgeCasesFor(inspect, recommendedDeploy),
  };
}

function sandboxDeployCommand(
  inspect: AppInspectResult,
  port: number,
  probePath: string,
): string {
  const args = [
    "miosa sandbox deploy",
    shellPath(inspect.path),
    `--template ${inspect.recommendation.template}`,
    `--port ${port}`,
    inspect.commands.dev ? `--start ${quote(inspect.commands.dev)}` : null,
    `--probe-path ${quote(probePath)}`,
    "--wait",
    "--timeout 900",
    "--json",
  ].filter(Boolean);
  return args.join(" ");
}

function publishCommand(
  deployment: AppPlanResult["recommended_deploy"],
  slug: string,
  buildCommand: string | null,
  runCommand: string | null,
  port: number,
  outputPath: string | null,
): string {
  const args = [
    "miosa sandbox publish <sandbox-id>",
    "--path /workspace",
    `--slug ${slug}`,
    deployment === "docker_deploy" ? "--docker-deploy" : null,
    buildCommand ? `--build-command ${quote(buildCommand)}` : null,
    runCommand ? `--run-command ${quote(runCommand)}` : null,
    runCommand ? `--port ${port}` : null,
    outputPath && !runCommand ? `--output ${quote(outputPath)}` : null,
    "--wait",
    "--timeout 900",
    "--json",
  ].filter(Boolean);
  return args.join(" ");
}

function detectPackageManager(dir: string): string | null {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))) return "bun";
  if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  if (fs.existsSync(path.join(dir, "uv.lock"))) return "uv";
  if (fs.existsSync(path.join(dir, "requirements.txt"))) return "pip";
  if (fs.existsSync(path.join(dir, "package.json"))) return "npm";
  return null;
}

function findDockerfile(dir: string): string | null {
  for (const file of ["Dockerfile", "dockerfile", "Containerfile"]) {
    const fullPath = path.join(dir, file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const fullPath = path.join(dir, "package.json");
  try {
    if (!fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageScripts(dir: string): Record<string, string> {
  const pkg = readPackageJson(dir);
  const scripts = pkg?.["scripts"];
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string" && value.trim()) result[key] = value.trim();
  }
  return result;
}

function packageScriptCommand(
  dir: string,
  packageManager: string | null,
  script: string,
  extraArgs = "",
): string | null {
  const scripts = packageScripts(dir);
  if (!scripts[script]) return null;
  const runner =
    packageManager === "pnpm"
      ? "pnpm"
      : packageManager === "yarn"
        ? "yarn"
        : packageManager === "bun"
          ? "bun"
          : "npm run";
  return `${runner} ${script}${extraArgs}`;
}

function packageHintsDatabase(dir: string): boolean {
  const pkg = readPackageJson(dir);
  if (!pkg) return false;
  const deps = {
    ...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}),
    ...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}),
  };
  return [
    "pg",
    "postgres",
    "prisma",
    "@prisma/client",
    "drizzle-orm",
    "better-sqlite3",
  ].some((dep) => dep in deps);
}

function devScriptArgs(framework: Framework | undefined, port: number | null): string {
  const p = port ?? 3000;
  if (framework === "nextjs") return ` -- -H 0.0.0.0 -p ${p}`;
  if (framework === "vite-react") return ` -- --host 0.0.0.0 --port ${p}`;
  if (framework === "sveltekit") return ` -- --host 0.0.0.0 --port ${p}`;
  return "";
}

function defaultDevCommand(
  framework: Framework | undefined,
  port: number | null,
): string | null {
  const p = port ?? 3000;
  if (framework === "nextjs") return `npm run dev -- -H 0.0.0.0 -p ${p}`;
  if (framework === "vite-react") return `npm run dev -- --host 0.0.0.0 --port ${p}`;
  if (framework === "sveltekit") return `npm run dev -- --host 0.0.0.0 --port ${p}`;
  return null;
}

function defaultInstallCommand(
  dir: string,
  packageManager: string | null,
): string | false | null {
  if (!packageManager) return null;
  if (packageManager === "pnpm") return "pnpm install";
  if (packageManager === "yarn") return "yarn install";
  if (packageManager === "bun") return "bun install";
  if (packageManager === "uv") return "uv sync";
  if (packageManager === "pip") return "pip install -r requirements.txt";
  if (fs.existsSync(path.join(dir, "package.json"))) return "npm install";
  return null;
}

function defaultOutputPath(framework?: Framework): string | null {
  if (framework === "vite-react") return "dist";
  if (framework === "sveltekit") return "build";
  if (framework === "static") return ".";
  return null;
}

function templateFor(framework: string, needsDatabase: boolean): string {
  if (framework === "nextjs") return needsDatabase ? "nextjs-postgres" : "nextjs";
  if (framework === "vite-react") return "vite-react";
  if (framework === "flask" || framework === "django") return "python-fastapi";
  if (framework === "static") return "static-html";
  if (framework === "unknown") return "node-22";
  return framework;
}

function recommendDeployment(
  best: DetectionResult | null,
  outputPath: string | null,
  needsDatabase: boolean,
  dockerfile: string | null,
): AppInspectResult["recommendation"]["deployment"] {
  if (dockerfile || needsDatabase) return "docker_deploy";
  if (best?.framework === "nextjs") return "docker_deploy";
  if (best?.framework === "static") return "static_publish";
  if (outputPath && ["vite-react", "sveltekit"].includes(best?.framework ?? "")) {
    return "static_publish";
  }
  return "docker_deploy";
}

function recommendationReason(
  deployment: AppInspectResult["recommendation"]["deployment"],
  framework?: Framework,
  needsDatabase?: boolean,
): string {
  if (deployment === "docker_deploy") {
    if (needsDatabase) return "App needs server-side runtime/env; App Engine is the recommended production path.";
    if (framework === "nextjs") return "Next.js commonly needs server/runtime support; App Engine is the safest default.";
    return "App Engine gives a durable runtime with lower-resource app hosting.";
  }
  if (deployment === "static_publish") {
    return "Detected build output can be served as static assets.";
  }
  return "Standard deploy selected by override or unknown runtime constraints.";
}

function detectEnvKeys(
  dir: string,
  best: DetectionResult | null,
  manifest: LoadedAppManifest | null,
): string[] {
  const keys = new Set<string>(best?.envKeysNeeded ?? []);
  if (manifest?.manifest.framework?.includes("postgres")) keys.add("DATABASE_URL");
  for (const file of [".env.example", ".env.sample", "env.example"]) {
    const fullPath = path.join(dir, file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line);
      if (match?.[1]) keys.add(match[1]);
    }
  }
  if (packageHintsDatabase(dir)) keys.add("DATABASE_URL");
  return [...keys].sort();
}

function detectRisks(
  dir: string,
  best: DetectionResult | null,
  port: number | null,
  runCommand: string | null,
  needsDatabase: boolean,
  dockerfile: string | null,
): string[] {
  const risks: string[] = [];
  if (!best) risks.push("No known framework detected; commands may need explicit manifest overrides.");
  if (!port) risks.push("No port detected; preview/publish should pass --port explicitly.");
  if (!runCommand) risks.push("No start/run command detected; dynamic production deploy needs one.");
  if (
    best?.framework &&
    ["nextjs", "vite-react", "sveltekit"].includes(best.framework)
  ) {
    const scripts = packageScripts(dir);
    if (!scripts["dev"]) {
      risks.push(
        "package.json has no dev script; sandbox preview may need an explicit --start command.",
      );
    }
    if (best.framework === "nextjs" && !scripts["start"]) {
      risks.push(
        "package.json has no start script; production publish may need an explicit --run-command.",
      );
    }
  }
  if (needsDatabase) risks.push("DATABASE_URL required; create/attach managed Postgres before publish.");
  if (port === 3000) risks.push("Port 3000 is common; run sandbox ports before previewing to catch conflicts.");
  if (!fs.existsSync(path.join(dir, "package.json")) && ["nextjs", "vite-react", "sveltekit"].includes(best?.framework ?? "")) {
    risks.push("JavaScript framework detected without package.json; template may be runtime-only.");
  }
  if (dockerfile) risks.push("Dockerfile present; verify build context and exposed port match MIOSA plan.");
  return risks;
}

function edgeCasesFor(
  inspect: AppInspectResult,
  deployment: AppPlanResult["recommended_deploy"],
): AppPlanResult["edge_cases"] {
  const cases: AppPlanResult["edge_cases"] = [
    {
      code: "AUTH_REVOKED",
      meaning: "Cached identity can exist while live API calls fail.",
      recovery: ["miosa whoami --json", "miosa login --api-key <fresh-key>"],
    },
    {
      code: "PORT_NOT_LISTENING",
      meaning: "The preview route exists but the app process is not listening.",
      recovery: [
        "miosa sandbox ports <sandbox-id> --json",
        "miosa sandbox service logs <sandbox-id> web --lines 100 --json",
      ],
    },
    {
      code: "GATEWAY_RESPONSE_DETECTED",
      meaning: "Public preview returned MIOSA gateway JSON instead of the user app.",
      recovery: [
        "miosa sandbox doctor <sandbox-id> --port <port> --json",
        "miosa sandbox ports <sandbox-id> --json",
      ],
    },
    {
      code: "DEPLOY_STILL_BUILDING",
      meaning: "A wait timeout does not mean the release failed.",
      recovery: [
        "miosa releases list <app-id-or-slug> --json",
        "miosa logs --deployment <app-id> --lines 200 --json",
      ],
    },
  ];

  if (inspect.runtime.needs_database) {
    cases.push({
      code: "DATABASE_NOT_RUNNING",
      meaning: "Do not inject or print a pending/failed database URL.",
      recovery: [
        "miosa databases get <db-id> --json",
        "miosa databases logs <db-id> --lines 100 --json",
      ],
    });
  }

  if (deployment === "docker_deploy") {
    cases.push({
      code: "DOCKER_DEPLOY_HOST_NOT_READY",
      meaning: "Workspace App Engine host must be active before app publish can finish.",
      recovery: [
        "miosa docker-deploy ensure --wait --timeout 600 --json",
        "miosa docker-deploy templates --json",
      ],
    });
    cases.push({
      code: "DOCKER_DEPLOY_ROUTE_UNHEALTHY",
      meaning:
        "The deployment can be marked running while the appliance route or public app port is unhealthy.",
      recovery: [
        "miosa docker-deploy doctor <deployment-id> --json",
        "miosa deploy show <deployment-id> --json",
        "miosa sandbox publish <sandbox-id> --docker-deploy --wait --timeout 900 --json",
      ],
    });
  }

  return cases;
}

function shellPath(value: string): string {
  if (value === process.cwd()) return ".";
  return quote(value);
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
