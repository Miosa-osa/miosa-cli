import fs from "node:fs";
import path from "node:path";

export type Framework =
  | "nextjs"
  | "sveltekit"
  | "vite-react"
  | "phoenix"
  | "django"
  | "flask"
  | "rails"
  | "go"
  | "rust"
  | "static";

export interface DetectionResult {
  framework: Framework;
  confidence: number; // 0–100
  buildCommand: string;
  runCommand: string;
  port?: number;
  envKeysNeeded: string[];
  filesExamined: string[];
}

type Detector = (dir: string) => DetectionResult | null;

// ── helpers ──────────────────────────────────────────────────────────────────

function exists(dir: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(dir, ...parts));
}

function readJson(dir: string, file: string): Record<string, unknown> | null {
  const p = path.join(dir, file);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pkgDeps(dir: string): Set<string> {
  const pkg = readJson(dir, "package.json");
  if (!pkg) return new Set();
  const deps = {
    ...((pkg["dependencies"] as Record<string, string> | undefined) ?? {}),
    ...((pkg["devDependencies"] as Record<string, string> | undefined) ?? {}),
  };
  return new Set(Object.keys(deps));
}

function fileContains(dir: string, file: string, needle: string): boolean {
  const p = path.join(dir, file);
  try {
    if (!fs.existsSync(p)) return false;
    return fs.readFileSync(p, "utf8").includes(needle);
  } catch {
    return false;
  }
}

// ── detectors ─────────────────────────────────────────────────────────────────

function detectNextjs(dir: string): DetectionResult | null {
  const deps = pkgDeps(dir);
  if (!deps.has("next")) return null;

  const filesExamined = ["package.json"];
  let confidence = 85;

  // Boost confidence if next.config.* exists
  if (
    exists(dir, "next.config.js") ||
    exists(dir, "next.config.ts") ||
    exists(dir, "next.config.mjs")
  ) {
    confidence = 95;
    filesExamined.push("next.config.*");
  }

  return {
    framework: "nextjs",
    confidence,
    buildCommand: "npm run build",
    runCommand: "npm start",
    port: 3000,
    envKeysNeeded: [],
    filesExamined,
  };
}

function detectSvelteKit(dir: string): DetectionResult | null {
  const deps = pkgDeps(dir);
  if (!deps.has("@sveltejs/kit")) return null;

  const filesExamined = ["package.json"];
  let confidence = 85;

  if (exists(dir, "svelte.config.js") || exists(dir, "svelte.config.ts")) {
    confidence = 95;
    filesExamined.push("svelte.config.*");
  }

  return {
    framework: "sveltekit",
    confidence,
    buildCommand: "npm run build",
    runCommand: "node build",
    port: 3000,
    envKeysNeeded: [],
    filesExamined,
  };
}

function detectViteReact(dir: string): DetectionResult | null {
  const deps = pkgDeps(dir);
  if (!deps.has("vite") || (!deps.has("react") && !deps.has("react-dom")))
    return null;

  const filesExamined = ["package.json"];
  let confidence = 80;

  if (exists(dir, "vite.config.ts") || exists(dir, "vite.config.js")) {
    confidence = 90;
    filesExamined.push("vite.config.*");
  }

  return {
    framework: "vite-react",
    confidence,
    buildCommand: "npm run build",
    runCommand: "npx serve dist",
    port: 5173,
    envKeysNeeded: [],
    filesExamined,
  };
}

function detectPhoenix(dir: string): DetectionResult | null {
  if (!exists(dir, "mix.exs")) return null;
  if (!fileContains(dir, "mix.exs", ":phoenix")) return null;

  const filesExamined = ["mix.exs"];
  let confidence = 85;

  if (exists(dir, "config", "config.exs")) {
    confidence = 92;
    filesExamined.push("config/config.exs");
  }

  // Try to derive app name for the run command
  const mixContent = (() => {
    try {
      return fs.readFileSync(path.join(dir, "mix.exs"), "utf8");
    } catch {
      return "";
    }
  })();
  const appMatch = /app:\s+:([a-z_]+)/.exec(mixContent);
  const appName = appMatch?.[1] ?? "app";

  return {
    framework: "phoenix",
    confidence,
    buildCommand: "mix deps.get && mix release",
    runCommand: `_build/prod/rel/${appName}/bin/${appName} start`,
    port: 4000,
    envKeysNeeded: ["SECRET_KEY_BASE", "DATABASE_URL"],
    filesExamined,
  };
}

function detectDjango(dir: string): DetectionResult | null {
  if (!exists(dir, "manage.py")) return null;
  if (!exists(dir, "requirements.txt")) return null;
  if (
    !fileContains(dir, "requirements.txt", "django") &&
    !fileContains(dir, "requirements.txt", "Django")
  )
    return null;

  const filesExamined = ["manage.py", "requirements.txt"];
  let confidence = 85;

  // Try to find wsgi/asgi module
  let wsgiModule = "mysite.wsgi";
  if (exists(dir, "wsgi.py")) {
    wsgiModule = "wsgi";
    confidence = 90;
    filesExamined.push("wsgi.py");
  }

  return {
    framework: "django",
    confidence,
    buildCommand:
      "pip install -r requirements.txt && python manage.py collectstatic --noinput",
    runCommand: `gunicorn ${wsgiModule}:application`,
    port: 8000,
    envKeysNeeded: ["SECRET_KEY", "DATABASE_URL"],
    filesExamined,
  };
}

function detectFlask(dir: string): DetectionResult | null {
  if (!exists(dir, "requirements.txt")) return null;
  if (
    !fileContains(dir, "requirements.txt", "flask") &&
    !fileContains(dir, "requirements.txt", "Flask")
  )
    return null;

  // Django wins if manage.py present — detect order handles this via scoring
  if (exists(dir, "manage.py")) return null;

  const filesExamined = ["requirements.txt"];
  let confidence = 75;

  // Determine app entry point
  let entryPoint = "app:app";
  if (exists(dir, "app.py")) {
    confidence = 85;
    filesExamined.push("app.py");
  } else if (exists(dir, "wsgi.py")) {
    entryPoint = "wsgi:app";
    confidence = 82;
    filesExamined.push("wsgi.py");
  }

  return {
    framework: "flask",
    confidence,
    buildCommand: "pip install -r requirements.txt",
    runCommand: `gunicorn ${entryPoint}`,
    port: 5000,
    envKeysNeeded: ["SECRET_KEY"],
    filesExamined,
  };
}

function detectRails(dir: string): DetectionResult | null {
  if (!exists(dir, "Gemfile")) return null;
  if (!exists(dir, "config", "application.rb")) return null;
  if (
    !fileContains(dir, "Gemfile", "rails") &&
    !fileContains(dir, "Gemfile", "Rails")
  )
    return null;

  const filesExamined = ["Gemfile", "config/application.rb"];
  let confidence = 88;

  if (exists(dir, "config", "routes.rb")) {
    confidence = 93;
    filesExamined.push("config/routes.rb");
  }

  return {
    framework: "rails",
    confidence,
    buildCommand:
      "bundle install && RAILS_ENV=production rails assets:precompile",
    runCommand: "rails server -e production",
    port: 3000,
    envKeysNeeded: ["SECRET_KEY_BASE", "DATABASE_URL", "RAILS_MASTER_KEY"],
    filesExamined,
  };
}

function detectGo(dir: string): DetectionResult | null {
  if (!exists(dir, "go.mod")) return null;

  const filesExamined = ["go.mod"];
  let confidence = 80;

  if (exists(dir, "main.go")) {
    confidence = 90;
    filesExamined.push("main.go");
  } else if (exists(dir, "cmd")) {
    confidence = 88;
    filesExamined.push("cmd/");
  }

  // Read module name for binary name
  let binaryName = "app";
  try {
    const modContent = fs.readFileSync(path.join(dir, "go.mod"), "utf8");
    const modMatch = /^module\s+(\S+)/m.exec(modContent);
    if (modMatch?.[1]) {
      binaryName = modMatch[1].split("/").pop() ?? "app";
    }
  } catch {
    // ignore
  }

  return {
    framework: "go",
    confidence,
    buildCommand: "go build -o app .",
    runCommand: `./${binaryName === "app" ? "app" : binaryName}`,
    port: 8080,
    envKeysNeeded: [],
    filesExamined,
  };
}

function detectRust(dir: string): DetectionResult | null {
  if (!exists(dir, "Cargo.toml")) return null;

  const filesExamined = ["Cargo.toml"];
  let confidence = 80;

  if (exists(dir, "src", "main.rs")) {
    confidence = 90;
    filesExamined.push("src/main.rs");
  }

  // Read package name for binary
  let binaryName = "app";
  try {
    const cargoContent = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargoContent);
    if (nameMatch?.[1]) {
      binaryName = nameMatch[1];
    }
  } catch {
    // ignore
  }

  return {
    framework: "rust",
    confidence,
    buildCommand: "cargo build --release",
    runCommand: `./target/release/${binaryName}`,
    port: 8080,
    envKeysNeeded: [],
    filesExamined,
  };
}

function detectStatic(dir: string): DetectionResult | null {
  if (!exists(dir, "index.html")) return null;

  // Only claim static if no known build system is present
  const hasPackageJson = exists(dir, "package.json");
  const hasMixExs = exists(dir, "mix.exs");
  const hasGoMod = exists(dir, "go.mod");
  const hasCargo = exists(dir, "Cargo.toml");
  const hasGemfile = exists(dir, "Gemfile");
  const hasRequirements = exists(dir, "requirements.txt");

  if (
    hasPackageJson ||
    hasMixExs ||
    hasGoMod ||
    hasCargo ||
    hasGemfile ||
    hasRequirements
  ) {
    return null;
  }

  return {
    framework: "static",
    confidence: 70,
    buildCommand: "",
    runCommand: "npx serve .",
    port: 3000,
    envKeysNeeded: [],
    filesExamined: ["index.html"],
  };
}

// ── registry ──────────────────────────────────────────────────────────────────

const DETECTORS: Detector[] = [
  detectNextjs,
  detectSvelteKit,
  detectViteReact,
  detectPhoenix,
  detectDjango,
  detectFlask,
  detectRails,
  detectGo,
  detectRust,
  detectStatic,
];

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Run all detectors against `dir` and return the highest-confidence result,
 * or null if nothing was detected with confidence >= 50.
 */
export function detectFramework(dir: string): DetectionResult | null {
  const results: DetectionResult[] = [];

  for (const detect of DETECTORS) {
    const result = detect(dir);
    if (result !== null) {
      results.push(result);
    }
  }

  if (results.length === 0) return null;

  results.sort((a, b) => b.confidence - a.confidence);
  const best = results[0];
  if (!best || best.confidence < 50) return null;

  return best;
}

/**
 * Run all detectors and return all results sorted by confidence,
 * useful for debugging or showing alternatives.
 */
export function detectFrameworkAll(dir: string): DetectionResult[] {
  const results: DetectionResult[] = [];

  for (const detect of DETECTORS) {
    const result = detect(dir);
    if (result !== null) {
      results.push(result);
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

export const FRAMEWORK_LABELS: Record<Framework, string> = {
  nextjs: "Next.js",
  sveltekit: "SvelteKit",
  "vite-react": "Vite + React",
  phoenix: "Phoenix (Elixir)",
  django: "Django",
  flask: "Flask",
  rails: "Ruby on Rails",
  go: "Go",
  rust: "Rust",
  static: "Static HTML",
};
