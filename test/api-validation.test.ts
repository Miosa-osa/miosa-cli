import { describe, expect, it } from "vitest";
import {
  fieldLabel,
  isUniquenessMessage,
  parseFieldIssues,
  renderFieldIssues,
} from "../src/api-validation.js";
import { ApiResponseError, mapHttpError } from "../src/errors.js";

describe("parseFieldIssues", () => {
  it("reads the Ecto changeset map the platform API sends at the top level", () => {
    const body = {
      error: {
        code: "VALIDATION_FAILED",
        message: "sandbox template is invalid",
      },
      errors: { slug: ["a template with this name already exists"] },
    };

    expect(parseFieldIssues(body)).toEqual([
      { field: "slug", message: "a template with this name already exists" },
    ]);
  });

  it("reads a multi-field changeset map", () => {
    const body = {
      errors: {
        name: ["can't be blank"],
        description: ["should be at most 1000 character(s)"],
      },
    };

    expect(parseFieldIssues(body)).toEqual([
      { field: "name", message: "can't be blank" },
      { field: "description", message: "should be at most 1000 character(s)" },
    ]);
  });

  it("reads the BuildSpec list-of-objects shape with its codes", () => {
    const body = {
      error: { code: "INVALID_BUILDSPEC", message: "BuildSpec is invalid" },
      errors: [
        { code: "REQUIRED", field: "from", message: "is required" },
        {
          code: "INVALID_PORT",
          field: "previewPort",
          message: "must be between 1 and 65535",
        },
      ],
    };

    expect(parseFieldIssues(body)).toEqual([
      { field: "from", message: "is required", code: "REQUIRED" },
      {
        field: "previewPort",
        message: "must be between 1 and 65535",
        code: "INVALID_PORT",
      },
    ]);
  });

  it("flattens nested changeset errors into dotted field paths", () => {
    const body = { errors: { build_spec: { steps: ["are invalid"] } } };

    expect(parseFieldIssues(body)).toEqual([
      { field: "build_spec.steps", message: "are invalid" },
    ]);
  });

  it("falls back to error.details when there is no top-level errors key", () => {
    const body = { error: { details: { region: ["is not available"] } } };

    expect(parseFieldIssues(body)).toEqual([
      { field: "region", message: "is not available" },
    ]);
  });

  it("returns nothing for a body with no per-field detail", () => {
    expect(parseFieldIssues({ error: { message: "boom" } })).toEqual([]);
    expect(parseFieldIssues("not json")).toEqual([]);
    expect(parseFieldIssues(null)).toEqual([]);
  });
});

describe("fieldLabel", () => {
  it("maps internal column names to the flag the caller controls", () => {
    expect(fieldLabel("slug")).toBe("name");
    expect(fieldLabel("from")).toBe("dockerfile (FROM)");
    expect(fieldLabel("build_spec.steps")).toBe("dockerfile.steps");
  });

  it("passes through a field it has no mapping for", () => {
    expect(fieldLabel("region")).toBe("region");
  });
});

describe("isUniquenessMessage", () => {
  it("recognises the messages Ecto and Postgres produce for a unique index", () => {
    expect(isUniquenessMessage("has already been taken")).toBe(true);
    expect(
      isUniquenessMessage("a template with this name already exists"),
    ).toBe(true);
    expect(isUniquenessMessage("can't be blank")).toBe(false);
  });
});

describe("renderFieldIssues", () => {
  it("labels a name collision as a name collision", () => {
    const rendered = renderFieldIssues(
      [{ field: "slug", message: "a template with this name already exists" }],
      ["name", "dockerfile"],
    );

    expect(rendered.lines).toEqual([
      "name: a template with this name already exists",
    ]);
    expect(rendered.hint).toContain("Pick a different --name");
  });

  it("refuses to blame a server-assigned field the request never sent", () => {
    // The pre-fix server attached a composite unique_constraint error to
    // :tenant_id, the first field in the index. Repeating that verbatim reads
    // as a tenancy fault the caller cannot act on.
    const rendered = renderFieldIssues(
      [{ field: "tenant_id", message: "has already been taken" }],
      ["name", "dockerfile"],
    );

    expect(rendered.lines[0]).toBe(
      "name: already used by one of your existing resources",
    );
    expect(rendered.lines[1]).toContain('reported this against "tenant_id"');
    expect(rendered.lines.join("\n")).not.toMatch(/^tenant_id:/m);
    expect(rendered.hint).toContain("Pick a different --name");
  });

  it("still reports a server-assigned field when the request did send it", () => {
    const rendered = renderFieldIssues(
      [{ field: "workspace_id", message: "has already been taken" }],
      ["workspace_id"],
    );

    expect(rendered.lines).toEqual(["workspace_id: has already been taken"]);
  });

  it("reports a non-uniqueness error on a server-assigned field verbatim", () => {
    const rendered = renderFieldIssues(
      [{ field: "tenant_id", message: "is invalid" }],
      ["name"],
    );

    expect(rendered.lines).toEqual(["tenant_id: is invalid"]);
  });

  it("renders every field of a multi-field rejection", () => {
    const rendered = renderFieldIssues(
      [
        { field: "name", message: "can't be blank" },
        {
          field: "description",
          message: "should be at most 1000 character(s)",
        },
      ],
      ["name", "description"],
    );

    expect(rendered.lines).toEqual([
      "name: can't be blank",
      "description: should be at most 1000 character(s)",
    ]);
  });
});

describe("mapHttpError with field-level errors", () => {
  it("carries the rendered lines and drops the raw-body dump", () => {
    const raw = JSON.stringify({
      error: {
        code: "VALIDATION_FAILED",
        message: "sandbox template is invalid",
      },
      errors: { slug: ["a template with this name already exists"] },
    });

    const err = mapHttpError(422, JSON.parse(raw), raw, "req_1", [
      "name",
      "dockerfile",
    ]);

    expect(err).toBeInstanceOf(ApiResponseError);
    const api = err as ApiResponseError;
    expect(api.code).toBe("VALIDATION_FAILED");
    expect(api.fieldErrors).toEqual([
      "name: a template with this name already exists",
    ]);
    expect(api.issues).toHaveLength(1);
    // The raw body was the only thing shown before, and it is noise once the
    // per-field lines exist.
    expect(api.details).toBeUndefined();
    expect(api.hint).toContain("Pick a different --name");
  });

  it("keeps the raw body when the server sent no per-field detail", () => {
    const raw = JSON.stringify({
      error: { code: "SOMETHING_ELSE", message: "nope" },
    });

    const api = mapHttpError(422, JSON.parse(raw), raw) as ApiResponseError;

    expect(api.fieldErrors).toEqual([]);
    expect(api.details).toBe(raw);
  });

  it("turns the pre-fix tenant_id attribution into an actionable message", () => {
    const raw = JSON.stringify({
      error: {
        code: "VALIDATION_FAILED",
        message: "sandbox template is invalid",
      },
      errors: { tenant_id: ["has already been taken"] },
    });

    const api = mapHttpError(422, JSON.parse(raw), raw, null, [
      "name",
      "dockerfile",
    ]) as ApiResponseError;

    expect(api.fieldErrors[0]).toBe(
      "name: already used by one of your existing resources",
    );
  });
});
