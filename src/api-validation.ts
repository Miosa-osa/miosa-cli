/**
 * Field-level validation errors from the platform API.
 *
 * The API reports rejected fields in a top-level `errors` key, in one of two
 * shapes depending on which validator refused:
 *
 *   Ecto changeset (`Ecto.Changeset.traverse_errors/2`) — a map of field to a
 *   list of messages, possibly nested for embedded schemas:
 *
 *     {"error":{"code":"VALIDATION_FAILED","message":"sandbox template is invalid"},
 *      "errors":{"slug":["a template with this name already exists"]}}
 *
 *   Hand-rolled spec validators (BuildSpec) — a list of objects:
 *
 *     {"error":{"code":"INVALID_BUILDSPEC","message":"BuildSpec is invalid"},
 *      "errors":[{"code":"REQUIRED","field":"from","message":"is required"}]}
 *
 * Neither shape was read before: the CLI only looked at `error.details`, so it
 * fell back to dumping the whole raw response body and the customer saw a JSON
 * blob naming an internal column (2026-08-26 live customer call).
 */

export interface FieldIssue {
  /** Server-reported field path, e.g. "slug" or "steps.0.run". */
  readonly field: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * Fields the client never sets: the server assigns them from the credential or
 * from its own request context. A validation error attributed to one of these
 * is a server-side attribution artifact, not something the caller can correct
 * by changing its request.
 */
const SERVER_ASSIGNED_FIELDS = new Set([
  "tenant_id",
  "organization_id",
  "owner_id",
  "user_id",
  "workspace_id",
  "account_id",
  "api_key_id",
]);

/**
 * Internal column names mapped to the flag or field a caller actually controls.
 * Keeps the CLI from telling someone to fix a field their command has no way
 * to set.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  slug: "name",
  build_spec: "dockerfile",
  normalized_build_spec: "dockerfile",
  dockerfile: "dockerfile",
  from: "dockerfile (FROM)",
  steps: "dockerfile (RUN/WORKDIR/ENV steps)",
  startCmd: "dockerfile (CMD/ENTRYPOINT)",
  previewPort: "dockerfile (EXPOSE)",
  artifactPaths: "dockerfile (artifact paths)",
};

/** Messages Ecto/Postgres produce for a unique-index violation. */
const UNIQUENESS_MESSAGE =
  /has already been taken|already exists|must be unique/i;

export function isUniquenessMessage(message: string): boolean {
  return UNIQUENESS_MESSAGE.test(message);
}

export function isServerAssignedField(field: string): boolean {
  return SERVER_ASSIGNED_FIELDS.has(rootField(field));
}

export function fieldLabel(field: string): string {
  const root = rootField(field);
  const mapped = FIELD_LABELS[root];
  if (!mapped) return field;
  const rest = field.slice(root.length);
  return `${mapped}${rest}`;
}

function rootField(field: string): string {
  const dot = field.indexOf(".");
  return dot === -1 ? field : field.slice(0, dot);
}

/**
 * Collect field-level issues from an error response body. Returns an empty
 * array when the body carries no per-field detail, so callers can fall back to
 * the top-level message.
 */
export function parseFieldIssues(body: unknown): FieldIssue[] {
  if (!isRecord(body)) return [];

  const candidates: unknown[] = [body["errors"]];
  if (isRecord(body["error"])) candidates.push(body["error"]["details"]);
  candidates.push(body["details"]);

  for (const candidate of candidates) {
    const issues = collect(candidate, "");
    if (issues.length > 0) return issues;
  }
  return [];
}

function collect(value: unknown, path: string): FieldIssue[] {
  if (value === null || value === undefined) return [];

  if (typeof value === "string") {
    return path === "" ? [] : [{ field: path, message: value }];
  }

  if (Array.isArray(value)) {
    // A list of message strings under a field path, or a list of
    // {field, message} objects at the top level.
    return value.flatMap((entry, index) => {
      if (typeof entry === "string") {
        return path === "" ? [] : [{ field: path, message: entry }];
      }
      if (isRecord(entry) && typeof entry["message"] === "string") {
        const field =
          asString(entry["field"]) ?? asString(entry["path"]) ?? path;
        if (!field) return [];
        return [
          {
            field,
            message: entry["message"],
            ...(asString(entry["code"])
              ? { code: asString(entry["code"]) as string }
              : {}),
          },
        ];
      }
      return collect(entry, path === "" ? String(index) : `${path}.${index}`);
    });
  }

  if (isRecord(value)) {
    // A single {field, message} object.
    if (typeof value["message"] === "string" && !("errors" in value)) {
      const field = asString(value["field"]) ?? asString(value["path"]) ?? path;
      if (field) {
        return [
          {
            field,
            message: value["message"],
            ...(asString(value["code"])
              ? { code: asString(value["code"]) as string }
              : {}),
          },
        ];
      }
    }
    return Object.entries(value).flatMap(([key, nested]) =>
      collect(nested, path === "" ? key : `${path}.${key}`),
    );
  }

  return [];
}

export interface RenderedIssues {
  /** One "field: message" line per issue, already labelled for the caller. */
  readonly lines: string[];
  /** Actionable next step, when the issues imply one. */
  readonly hint?: string;
}

/**
 * Turn field issues into the lines the CLI prints.
 *
 * `sentFields` are the top-level keys the CLI actually put in the request body.
 * They are what makes the misattribution guard possible: when the server blames
 * a field the request never set (the `[:tenant_id, :slug]` unique_constraint
 * case, where Ecto attaches a composite-index error to the FIRST field), the
 * CLI must not repeat that blame back to the user as if it were their input.
 */
export function renderFieldIssues(
  issues: readonly FieldIssue[],
  sentFields: readonly string[] = [],
): RenderedIssues {
  if (issues.length === 0) return { lines: [] };

  const sent = new Set(sentFields);
  const lines: string[] = [];
  const hints: string[] = [];

  for (const issue of issues) {
    const root = rootField(issue.field);
    const misattributed =
      isServerAssignedField(issue.field) &&
      !sent.has(root) &&
      isUniquenessMessage(issue.message);

    if (misattributed) {
      // The request never carried this field, so the caller cannot act on it.
      // Report the collision as a collision and name the misattribution
      // instead of parroting an internal column back at the user.
      const collided = nameLikeField(sentFields);
      lines.push(
        collided
          ? `${collided}: already used by one of your existing resources`
          : "already exists: this resource is already registered",
      );
      lines.push(
        `(the server reported this against "${issue.field}", ` +
          `which this command did not send - treat it as a duplicate, not a tenancy problem)`,
      );
      hints.push(
        collided
          ? `Pick a different --${collided}, or remove the existing one first.`
          : "Pick a different name, or remove the existing resource first.",
      );
      continue;
    }

    lines.push(`${fieldLabel(issue.field)}: ${issue.message}`);

    if (isUniquenessMessage(issue.message)) {
      const label = fieldLabel(issue.field);
      hints.push(
        `Pick a different --${label}, or remove the existing one first.`,
      );
    }
  }

  const hint = hints[0];
  return hint === undefined ? { lines } : { lines, hint };
}

/** The most name-like field the request actually sent, for a duplicate hint. */
function nameLikeField(sentFields: readonly string[]): string | undefined {
  for (const candidate of ["name", "slug", "title", "id"]) {
    if (sentFields.includes(candidate))
      return candidate === "slug" ? "name" : candidate;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
