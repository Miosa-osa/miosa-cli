#!/usr/bin/env node
/**
 * Stand-in for the MIOSA platform API, used to exercise the real `miosa` binary
 * end to end without touching production or a customer tenant.
 *
 * Every response body below is transcribed from the Elixir source of truth so
 * the CLI sees byte-for-byte what a real server sends:
 *
 *   GET  /api/v1/sandbox-templates      -> apps/web/.../sandbox_templates_controller.ex :index
 *                                          (bare JSON array; built-ins from
 *                                          Engine.Sandbox.Templates.list/1 plus the tenant's
 *                                          own rows, all passed through
 *                                          Templates.render_for_catalog/1, whose Map.take
 *                                          drops :slug and :inserted_at)
 *   POST /api/v1/sandbox-templates      -> :create (201 %{data: render_template(...)},
 *                                          422 %{error: %{code: ...}, errors: <changeset|list>})
 *   GET  /api/v1/sandbox-templates/:id  -> :show (bare render_template/1, no data wrapper)
 *   GET  /api/v1/sandbox-templates/:id/builds -> :list_builds (%{data: [render_build(...)]})
 *   POST /api/v1/sandbox-templates/:id/builds -> :create_build
 *   DELETE /api/v1/sandbox-templates/:id      -> :delete (204, or 409 TEMPLATE_IN_USE)
 *
 * Usage:
 *   node scripts/fake-platform-api.mjs --scenario <name> [--port 0]
 * Prints "listening <url>" on stdout once bound.
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

function arg(name, fallback) {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

/** One built-in catalog row as render_for_catalog/1 emits it. */
function builtIn(id, name, category) {
  return {
    id,
    name,
    description: `${name} built-in template`,
    image_id: "miosa-sandbox-prod-1",
    default: id === "miosa-sandbox",
    built_in: true,
    status: "active",
    disk_mb: 10240,
    workdir: "/workspace",
    preview_port: 3000,
    install_command: null,
    start_command: null,
    readiness_probe: null,
    runtimes: ["bash", "node", "python"],
    artifact_paths: ["/workspace"],
    tags: [category],
    categories: [category],
    default_cpu: 2,
    default_memory_mb: 4096,
  };
}

// 22 public built-ins, sorted by {category, id} exactly like Templates.list/1.
const BUILT_INS = [
  ["hono-auth", "Hono Auth", "backend"],
  ["fastapi", "FastAPI", "backend"],
  ["express-api", "Express API", "backend"],
  ["go-api", "Go API", "backend"],
  ["rails", "Rails", "backend"],
  ["phoenix", "Phoenix", "backend"],
  ["miosa-sandbox", "MIOSA Sandbox", "general"],
  ["miosa-sandbox-prod-1", "MIOSA Sandbox (prod-1)", "general"],
  ["blank", "Blank", "general"],
  ["python-data", "Python Data", "data"],
  ["jupyter", "Jupyter", "data"],
  ["duckdb", "DuckDB", "data"],
  ["nextjs", "Next.js", "frontend"],
  ["vite-react", "Vite React", "frontend"],
  ["sveltekit", "SvelteKit", "frontend"],
  ["astro", "Astro", "frontend"],
  ["remix", "Remix", "frontend"],
  ["nuxt", "Nuxt", "frontend"],
  ["playwright", "Playwright", "testing"],
  ["vitest", "Vitest", "testing"],
  ["k6", "k6", "testing"],
  ["desktop", "Desktop", "desktop"],
]
  .map(([id, name, category]) => builtIn(id, name, category))
  .sort((a, b) =>
    a.categories[0] === b.categories[0]
      ? a.id.localeCompare(b.id)
      : a.categories[0].localeCompare(b.categories[0]),
  );

const CUSTOM_UUID = "9f2c1d70-4b3a-4a51-8d21-0c7e6b5a1f44";

/** TemplateRegistry.render_template/1 for a tenant-owned row. */
export function renderTemplate(overrides = {}) {
  return {
    id: CUSTOM_UUID,
    name: "hackerai-scanner",
    slug: "hackerai-scanner",
    description: null,
    image_id: null,
    category: "custom",
    default: false,
    built_in: false,
    public: false,
    status: "draft",
    cpu_count: 2,
    memory_mb: 4096,
    disk_mb: 10240,
    workdir: "/workspace",
    preview_port: null,
    install_command: null,
    start_command: null,
    readiness_probe: null,
    runtimes: [],
    artifact_paths: [],
    build_spec: {
      from: "node:22-bookworm",
      size: "small",
      vcpu: 2,
      memoryMib: 4096,
      diskMib: 10240,
      steps: [{ run: "npm install -g pnpm" }],
      env: {},
      workdir: "/workspace",
      user: "root",
      startCmd: null,
      readyCmd: null,
      previewPort: null,
      artifactPaths: [],
    },
    current_build_id: null,
    inserted_at: "2026-08-26T14:02:11Z",
    updated_at: "2026-08-26T14:02:11Z",
    ...overrides,
  };
}

/**
 * The exact atom list `Templates.render/1` passes to `Map.take/2`. Exported so
 * test/server-contract.test.ts can compare it against the real Elixir source
 * rather than against a second hand-maintained copy.
 */
export const CATALOG_TAKE_KEYS = [
  "id",
  "name",
  "description",
  "image_id",
  "category",
  "default",
  "built_in",
  "status",
  "cpu_count",
  "memory_mb",
  "disk_mb",
  "workdir",
  "preview_port",
  "install_command",
  "start_command",
  "readiness_probe",
  "runtimes",
  "artifact_paths",
  "tags",
];

/** Templates.render_for_catalog/1 applied to an already-rendered custom row. */
export function catalogRow(template) {
  const taken = {};
  for (const key of CATALOG_TAKE_KEYS) {
    if (key in template) taken[key] = template[key];
  }
  const { category, cpu_count, memory_mb, ...rest } = taken;
  return {
    ...rest,
    categories: category === undefined ? [] : [category],
    default_cpu: cpu_count ?? null,
    default_memory_mb: memory_mb ?? null,
  };
}

export function renderBuild(overrides = {}) {
  return {
    id: "b1d0f3a8-77c2-4a19-9a41-3f5d2c8e7b60",
    sandbox_template_id: CUSTOM_UUID,
    source_type: "build_spec",
    state: "queued",
    image_id: null,
    rootfs_path: null,
    snapshot_manifest: null,
    log_url: null,
    error_code: null,
    error_message: null,
    metadata: { events: [{ event: "queued", at: "2026-08-26T14:02:11Z" }] },
    certification: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    build_spec: renderTemplate().build_spec,
    inserted_at: "2026-08-26T14:02:11Z",
    updated_at: "2026-08-26T14:02:11Z",
    ...overrides,
  };
}

/** Scenario table. Each entry supplies the handlers this scenario overrides. */
const SCENARIOS = {
  // Customer's exact failure on the pre-fix server: the composite
  // unique_constraint([:tenant_id, :slug]) attached its error to :tenant_id.
  "collision-legacy": {
    createStatus: 422,
    createBody: {
      error: { code: "VALIDATION_FAILED", message: "sandbox template is invalid" },
      errors: { tenant_id: ["has already been taken"] },
    },
  },
  // Same collision on the fixed server (error_key: :slug + human message).
  "collision-fixed": {
    createStatus: 422,
    createBody: {
      error: { code: "VALIDATION_FAILED", message: "sandbox template is invalid" },
      errors: { slug: ["a template with this name already exists"] },
    },
  },
  // BuildSpec rejection: `errors` is a LIST of %{code, field, message}.
  "buildspec-invalid": {
    createStatus: 422,
    createBody: {
      error: { code: "INVALID_BUILDSPEC", message: "BuildSpec is invalid" },
      errors: [
        { code: "REQUIRED", field: "from", message: "is required" },
        { code: "INVALID_PORT", field: "previewPort", message: "must be between 1 and 65535" },
      ],
    },
  },
  // Multi-field changeset rejection.
  "changeset-multi": {
    createStatus: 422,
    createBody: {
      error: { code: "VALIDATION_FAILED", message: "sandbox template is invalid" },
      errors: {
        name: ["can't be blank"],
        description: ["should be at most 1000 character(s)"],
      },
    },
  },
  // Create succeeds; template exists but has no usable build yet.
  happy: {},
  // Create succeeds and the build already finished.
  ready: { templateStatus: "ready" },
  // A template that is ready, so re-create over the name is a real collision.
  "update-ready": { templateStatus: "ready", createStatus: 422, createBody: {
    error: { code: "VALIDATION_FAILED", message: "sandbox template is invalid" },
    errors: { slug: ["a template with this name already exists"] },
  } },
  // Tenant has no custom templates at all.
  "no-custom": { noCustom: true },
  // The build ran and failed: error_code/error_message must reach the user.
  "build-failed": { templateStatus: "failed" },
  // Platform build gate is off fleet-wide: template "draft", build "failed".
  "builds-disabled": { templateStatus: "builds-disabled" },
  // Delete refused because something live depends on the template.
  "delete-in-use": {
    deleteStatus: 409,
    deleteBody: {
      error: {
        code: "TEMPLATE_IN_USE",
        message:
          "this template has a live sandbox or an active build depending on it; " +
          "wait for the build to finish or stop the dependent sandboxes first",
        sandboxes: 2,
        builds: 0,
      },
    },
  },
};

/**
 * Everything below is the running server. It is inside main() so that
 * importing this module for its shape definitions (see
 * test/server-contract.test.ts) neither reads argv nor binds a port nor
 * calls process.exit.
 */
function main() {
  const scenario = arg("scenario", "happy");
  const port = Number(arg("port", "0"));
  const config = SCENARIOS[scenario];
  if (!config) {
    process.stderr.write(`unknown scenario: ${scenario}\n`);
    process.exit(2);
  }

  const templateStatus = config.templateStatus ?? "draft";
  const TEMPLATE_BY_STATUS = {
    ready: {
      status: "ready",
      image_id: "sbxtpl-hackerai-scanner-01",
      current_build_id: renderBuild().id,
    },
    failed: { status: "failed", current_build_id: renderBuild().id },
    // Template stays "draft" even though its only build failed.
    "builds-disabled": { status: "draft", current_build_id: renderBuild().id },
  };
  const template = renderTemplate(TEMPLATE_BY_STATUS[templateStatus] ?? {});
  const BUILD_BY_STATUS = {
    ready: {
      state: "ready",
      image_id: "sbxtpl-hackerai-scanner-01",
      started_at: "2026-08-26T14:02:20Z",
      finished_at: "2026-08-26T14:05:02Z",
      duration_ms: 162000,
    },
    // The live fleet condition: sandbox_template_builds_enabled is false, so
    // fail_build/2 records the build as failed with BUILDS_TEMPORARILY_UNAVAILABLE
    // while template_status_after_failure(:builds_disabled) keeps the template
    // itself "draft" (miosa-compute fbd4a3f5).
    "builds-disabled": {
      state: "failed",
      error_code: "BUILDS_TEMPORARILY_UNAVAILABLE",
      error_message:
        "Template builds are being upgraded to run inside isolated per-tenant " +
        "microVMs and are temporarily unavailable. Your template was saved as a " +
        "draft and will build once this ships.",
      started_at: "2026-08-26T14:02:20Z",
      finished_at: "2026-08-26T14:02:21Z",
      duration_ms: 1000,
    },
    failed: {
      state: "failed",
      error_code: "BUILD_STEP_FAILED",
      error_message: "step 3 `npm ci` exited 1: ENOENT package-lock.json",
      started_at: "2026-08-26T14:02:20Z",
      finished_at: "2026-08-26T14:03:40Z",
      duration_ms: 80000,
    },
  };
  const build = renderBuild(BUILD_BY_STATUS[templateStatus] ?? {});

  const requests = [];

  function send(res, status, body, headers = {}) {
    const payload = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": "req_fake_0001",
      ...headers,
    });
    res.end(payload);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);

    let bodyText = "";
    req.on("data", (chunk) => {
      bodyText += chunk;
    });
    req.on("end", () => {
      if (path === "/api/v1/__requests") return send(res, 200, requests);

      if (path === "/api/v1/sandbox-templates" && req.method === "GET") {
        const rows = config.noCustom
          ? BUILT_INS
          : [...BUILT_INS, catalogRow(template)];
        return send(res, 200, rows);
      }

      if (path === "/api/v1/sandbox-templates" && req.method === "POST") {
        if (config.createStatus === 422) {
          return send(res, 422, config.createBody);
        }
        return send(res, 201, { data: template });
      }

      const showMatch = /^\/api\/v1\/sandbox-templates\/([^/]+)$/.exec(path);
      if (showMatch && req.method === "GET") {
        const id = decodeURIComponent(showMatch[1]);
        if (id === template.id || id === template.slug) {
          // :show sends the bare rendered map, with no data wrapper.
          return send(res, 200, template);
        }
        return send(res, 404, {
          error: { code: "TEMPLATE_NOT_FOUND", message: "sandbox template not found" },
        });
      }

      if (showMatch && req.method === "DELETE") {
        if (config.deleteStatus === 409) return send(res, 409, config.deleteBody);
        return send(res, 204, null);
      }

      const buildsMatch = /^\/api\/v1\/sandbox-templates\/([^/]+)\/builds$/.exec(path);
      if (buildsMatch && req.method === "GET") {
        return send(res, 200, { data: [build] });
      }
      if (buildsMatch && req.method === "POST") {
        return send(res, 201, { data: renderBuild() });
      }

      return send(res, 404, {
        error: { code: "NOT_FOUND", message: `no fake route for ${req.method} ${path}` },
      });
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`listening http://127.0.0.1:${address.port}\n`);
  });
}

// Only run the server when invoked directly, not when imported.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
