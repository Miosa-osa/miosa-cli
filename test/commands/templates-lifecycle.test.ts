import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `miosa templates` against the API's real response shapes.
 *
 * Every body here is transcribed from the Elixir source so the assertions
 * cannot drift from the server by agreeing with a convenient fiction:
 *
 *   GET  /api/v1/sandbox-templates      bare array; built-ins and custom rows
 *                                       both rendered by
 *                                       Templates.render_for_catalog/1, whose
 *                                       Map.take drops :slug and :inserted_at
 *                                       from a custom row.
 *   POST /api/v1/sandbox-templates      201 %{data: render_template(...)}
 *   GET  /api/v1/sandbox-templates/:id  bare render_template/1, no wrapper
 *   GET  .../:id/builds                 %{data: [render_build(...)]}
 */

vi.mock("../../src/config.js", () => ({
  loadConfig: () => ({
    endpoint: "https://api.miosa.ai",
    api_key: "msk_u_test",
    default_host: null,
  }),
  getConfigPath: () => "/tmp/miosa-test/config.json",
}));

const { register } = await import("../../src/commands/templates.js");

const TEMPLATE_ID = "9f2c1d70-4b3a-4a51-8d21-0c7e6b5a1f44";
const BUILD_ID = "b1d0f3a8-77c2-4a19-9a41-3f5d2c8e7b60";

function customTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
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
    build_spec: { from: "node:22-bookworm", size: "small" },
    current_build_id: null,
    inserted_at: "2026-08-26T14:02:11Z",
    updated_at: "2026-08-26T14:02:11Z",
    ...overrides,
  };
}

/** The same row after Templates.render_for_catalog/1 has stripped it. */
function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    name: "hackerai-scanner",
    description: null,
    image_id: null,
    built_in: false,
    status: "draft",
    disk_mb: 10240,
    categories: ["custom"],
    default_cpu: 2,
    default_memory_mb: 4096,
    ...overrides,
  };
}

function builtInRow(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} built-in`,
    image_id: "miosa-sandbox-prod-1",
    built_in: true,
    status: "active",
    categories: ["general"],
    default_cpu: 2,
    default_memory_mb: 4096,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  return {
    id: BUILD_ID,
    sandbox_template_id: TEMPLATE_ID,
    source_type: "build_spec",
    state: "queued",
    image_id: null,
    error_code: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function program(): Command {
  const command = new Command();
  command.exitOverride();
  register(command);
  return command;
}

let mock: MockAgent;
let out: string[];
let errOut: string[];

function pool() {
  return mock.get("https://api.miosa.ai");
}

function stdout(): string {
  return out.join("\n");
}

function stderr(): string {
  return errOut.join("\n");
}

function dockerfileAt(contents = "FROM node:22-bookworm\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "miosa-tpl-"));
  const path = join(dir, "Dockerfile");
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  out = [];
  errOut = [];
  vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errOut.push(args.map(String).join(" "));
  });
});

afterEach(() => vi.restoreAllMocks());

describe("miosa templates create", () => {
  it("reports a name collision as a name collision, not as tenant_id", async () => {
    // The pre-fix server attributed the composite unique_constraint error to
    // its first field, :tenant_id. The CLI must not repeat that as if the
    // caller had sent a tenant_id.
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(
        422,
        JSON.stringify({
          error: {
            code: "VALIDATION_FAILED",
            message: "sandbox template is invalid",
          },
          errors: { tenant_id: ["has already been taken"] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stderr()).toContain(
      "name: already used by one of your existing resources",
    );
    expect(stderr()).toContain('reported this against "tenant_id"');
    expect(stderr()).toContain("Pick a different --name");
    // No raw JSON dump.
    expect(stderr()).not.toContain('{"error"');
  });

  it("labels the fixed server's slug collision as the --name flag", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(
        422,
        JSON.stringify({
          error: {
            code: "VALIDATION_FAILED",
            message: "sandbox template is invalid",
          },
          errors: { slug: ["a template with this name already exists"] },
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stderr()).toContain("name: a template with this name already exists");
    expect(stderr()).not.toContain("slug:");
  });

  it("renders each BuildSpec field rejection on its own line", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(
        422,
        JSON.stringify({
          error: { code: "INVALID_BUILDSPEC", message: "BuildSpec is invalid" },
          errors: [
            { code: "REQUIRED", field: "from", message: "is required" },
            {
              code: "INVALID_PORT",
              field: "previewPort",
              message: "must be between 1 and 65535",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "x",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stderr()).toContain("dockerfile (FROM): is required");
    expect(stderr()).toContain(
      "dockerfile (EXPOSE): must be between 1 and 65535",
    );
  });

  it("posts the Dockerfile contents and confirms the row by reading it back", async () => {
    let posted: unknown;
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(201, (opts) => {
        posted = JSON.parse(String(opts.body));
        return JSON.stringify({ data: customTemplate() });
      }, { headers: { "content-type": "application/json" } });
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "GET" })
      .reply(200, JSON.stringify(customTemplate()), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [build()] }), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt("FROM node:22-bookworm\nRUN npm i -g pnpm\n"),
    ]);

    expect(posted).toEqual({
      name: "hackerai-scanner",
      dockerfile: "FROM node:22-bookworm\nRUN npm i -g pnpm\n",
    });
    expect(stdout()).toContain("Exists");
    expect(stdout()).toContain("confirmed by a follow-up read");
    // A queued build is not a usable template, and must not read as one.
    expect(stdout()).toMatch(/Usable\s+no - build .* is queued/);
    expect(stdout()).toContain("Not bootable yet");
  });

  it("says a template is usable only once a build produced an image", async () => {
    const ready = customTemplate({
      status: "ready",
      image_id: "sbxtpl-hackerai-scanner-01",
      current_build_id: BUILD_ID,
    });
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(201, JSON.stringify({ data: ready }), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "GET" })
      .reply(200, JSON.stringify(ready), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [build({ state: "ready", image_id: "sbxtpl-hackerai-scanner-01" })],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stdout()).toMatch(/Usable\s+yes - build complete/);
    expect(stdout()).toContain(
      "miosa sandbox create --template hackerai-scanner",
    );
    expect(stdout()).not.toContain("Not bootable yet");
  });

  it("warns when a 201 create cannot be read back", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(201, JSON.stringify({ data: customTemplate() }), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "GET" })
      .reply(
        404,
        JSON.stringify({
          error: { code: "TEMPLATE_NOT_FOUND", message: "sandbox template not found" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(404, JSON.stringify({ error: { code: "TEMPLATE_NOT_FOUND" } }), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "create",
      "--name",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stdout()).toContain(
      "the create call returned 201 but the follow-up read did not find this template",
    );
  });
});

describe("miosa templates list", () => {
  const catalog = [
    builtInRow("blank", "Blank"),
    builtInRow("nextjs", "Next.js"),
    builtInRow("miosa-sandbox", "MIOSA Sandbox"),
    catalogRow(),
  ];

  it("marks the caller's own template and lists it before the built-ins", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync(["node", "miosa", "templates", "list"]);

    const text = stdout();
    expect(text).toContain("SOURCE");
    expect(text).toContain("yours");
    expect(text).toContain("built-in");
    // The customer's row must not be buried at the bottom of the built-ins.
    expect(text.indexOf("hackerai-scanner")).toBeLessThan(text.indexOf("Blank"));
    expect(text).toContain("1 of these is yours");
    expect(text).toContain("the other 3 are platform built-ins");
  });

  it("shows only the caller's templates with --mine", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync(["node", "miosa", "templates", "list", "--mine"]);

    expect(stdout()).toContain("hackerai-scanner");
    expect(stdout()).not.toContain("Next.js");
    expect(stdout()).toContain("1 template created by this workspace");
  });

  it("says so plainly when the workspace owns no templates", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "GET" })
      .reply(200, JSON.stringify([builtInRow("blank", "Blank")]), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync(["node", "miosa", "templates", "list", "--mine"]);

    expect(stdout()).toContain(
      "This workspace has not created any sandbox templates",
    );
  });

  it("--verify reads each of the caller's rows back to fill in what the catalog drops", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "GET" })
      .reply(200, JSON.stringify(catalog), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "GET" })
      .reply(200, JSON.stringify(customTemplate()), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "list",
      "--mine",
      "--verify",
    ]);

    // slug and inserted_at exist only on the per-row read.
    expect(stdout()).toContain("TEMPLATE REF");
    expect(stdout()).toContain("2026-08-26");
  });

  it("never shows a draft template as usable", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "GET" })
      .reply(200, JSON.stringify([catalogRow()]), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync(["node", "miosa", "templates", "list", "--mine"]);

    expect(stdout()).toContain("USABLE");
    expect(stdout()).toMatch(/draft\s+no/);
  });
});

describe("miosa templates get", () => {
  it("states existence, usability, and the reason", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates/hackerai-scanner", method: "GET" })
      .reply(200, JSON.stringify(customTemplate({ status: "failed" })), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            build({
              state: "failed",
              error_code: "BUILD_STEP_FAILED",
              error_message: "step 3 `npm ci` exited 1",
            }),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "get",
      "hackerai-scanner",
    ]);

    expect(stdout()).toMatch(/Exists\s+yes/);
    expect(stdout()).toContain(
      "last build failed: BUILD_STEP_FAILED: step 3 `npm ci` exited 1",
    );
    expect(stdout()).toContain("Not bootable yet");
  });
});

describe("miosa templates builds", () => {
  it("shows the failure the API actually reports (error_code/error_message)", async () => {
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({
          data: [
            build({
              state: "failed",
              error_code: "BUILDS_TEMPORARILY_UNAVAILABLE",
              error_message: "your template was saved as a draft",
            }),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "builds",
      TEMPLATE_ID,
    ]);

    expect(stdout()).toContain("BUILDS_TEMPORARILY_UNAVAILABLE");
  });
});

describe("miosa templates update", () => {
  it("upserts the row in place while it has no usable build", async () => {
    let posted: unknown;
    pool()
      .intercept({ path: "/api/v1/sandbox-templates/hackerai-scanner", method: "GET" })
      .reply(200, JSON.stringify(customTemplate()), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({ path: "/api/v1/sandbox-templates", method: "POST" })
      .reply(201, (opts) => {
        posted = JSON.parse(String(opts.body));
        return JSON.stringify({ data: customTemplate() });
      }, { headers: { "content-type": "application/json" } });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [build()] }), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "update",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt("FROM node:24-bookworm\n"),
    ]);

    // The upsert targets the same tenant+slug, so the slug must be sent
    // explicitly rather than re-derived from the name.
    expect(posted).toEqual({
      name: "hackerai-scanner",
      slug: "hackerai-scanner",
      dockerfile: "FROM node:24-bookworm\n",
    });
    // ora writes the spinner line to stderr, so the mechanism is stated on
    // stdout too; that is what a caller and a script both see.
    expect(stdout()).toContain("its stored Dockerfile was replaced in place");
    expect(stdout()).toContain("Same template ID, same name");
  });

  it("starts a new build instead when the template already has a usable image", async () => {
    let posted: unknown;
    const ready = customTemplate({
      status: "ready",
      image_id: "sbxtpl-hackerai-scanner-01",
      current_build_id: BUILD_ID,
    });
    pool()
      .intercept({ path: "/api/v1/sandbox-templates/hackerai-scanner", method: "GET" })
      .reply(200, JSON.stringify(ready), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "POST",
      })
      .reply(201, (opts) => {
        posted = JSON.parse(String(opts.body));
        return JSON.stringify({ data: build() });
      }, { headers: { "content-type": "application/json" } });
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "GET" })
      .reply(200, JSON.stringify(ready), {
        headers: { "content-type": "application/json" },
      });
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "GET",
      })
      .reply(200, JSON.stringify({ data: [build()] }), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "update",
      "hackerai-scanner",
      "--dockerfile",
      dockerfileAt("FROM node:24-bookworm\n"),
    ]);

    expect(posted).toEqual({ dockerfile: "FROM node:24-bookworm\n" });
    expect(stdout()).toContain("already had a usable image");
    expect(stdout()).toContain("building as a new build instead");
  });

  it("refuses to update a platform built-in", async () => {
    pool()
      .intercept({ path: "/api/v1/sandbox-templates/nextjs", method: "GET" })
      .reply(200, JSON.stringify(builtInRow("nextjs", "Next.js")), {
        headers: { "content-type": "application/json" },
      });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "update",
      "nextjs",
      "--dockerfile",
      dockerfileAt(),
    ]);

    expect(stderr()).toContain("platform built-in template and cannot be updated");
  });
});

describe("miosa templates rebuild", () => {
  it("posts a build with no body when no Dockerfile is supplied", async () => {
    let posted: unknown;
    pool()
      .intercept({
        path: `/api/v1/sandbox-templates/${TEMPLATE_ID}/builds`,
        method: "POST",
      })
      .reply(201, (opts) => {
        posted = JSON.parse(String(opts.body));
        return JSON.stringify({ data: build() });
      }, { headers: { "content-type": "application/json" } });

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "rebuild",
      TEMPLATE_ID,
    ]);

    expect(posted).toEqual({});
    expect(stdout()).toContain(BUILD_ID);
  });
});

describe("miosa templates delete", () => {
  it("turns a TEMPLATE_IN_USE refusal into the remedy", async () => {
    pool()
      .intercept({ path: `/api/v1/sandbox-templates/${TEMPLATE_ID}`, method: "DELETE" })
      .reply(
        409,
        JSON.stringify({
          error: {
            code: "TEMPLATE_IN_USE",
            message:
              "this template has a live sandbox or an active build depending on it",
            sandboxes: 2,
            builds: 0,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );

    await program().parseAsync([
      "node",
      "miosa",
      "templates",
      "delete",
      TEMPLATE_ID,
      "--force",
    ]);

    expect(stderr()).toContain("Stop the sandboxes booted from this template");
  });
});
