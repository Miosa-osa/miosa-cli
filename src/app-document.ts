export interface AppDocumentDiagnostic {
  ok: boolean;
  app_document_id: string | null;
  workspace_id: string | null;
  version_hash: string | null;
  version_approved: boolean;
  publication_current: boolean;
  venue: "generated" | "served" | "invalid";
  capabilities: string[];
  connectors: string[];
  automations: number;
  checks: Array<{
    id: string;
    ok: boolean;
    detail: string;
    recovery: string | null;
  }>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown, key: string): string | null {
  const found = record(value)[key];
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

export function diagnoseAppDocument(
  raw: unknown,
  expectedWorkspaceId?: string | null,
): AppDocumentDiagnostic {
  const outer = record(raw);
  const app = Object.keys(record(outer["data"])).length
    ? record(outer["data"])
    : outer;
  const document = record(app["document"]);
  const view = record(document["view"]);
  const approval = record(app["approval"]);
  const publication = record(app["publication"]);
  const appId = stringValue(app, "id");
  const workspaceId = stringValue(app, "workspace_id");
  const versionHash = stringValue(app, "version_hash");
  const format = stringValue(document, "format");
  const viewKind = stringValue(view, "kind");
  const versionApproved = app["version_approved"] === true;
  const approvalHash = stringValue(approval, "version_hash");
  const publishedVersionHash = stringValue(publication, "version_hash");
  const publishedDeploymentId = stringValue(publication, "deployment_id");
  const publishedReleaseId = stringValue(publication, "release_id");
  const publicationCurrent = Boolean(
    versionHash &&
      publishedVersionHash === versionHash &&
      publishedDeploymentId &&
      publishedReleaseId,
  );
  const capabilities = strings(document["capabilities"]);
  const connectors = strings(document["connectors"]);
  const automations = Array.isArray(document["automations"])
    ? document["automations"].length
    : 0;

  const checks = [
    {
      id: "document_shape",
      ok: Boolean(appId && format === "miosa-app/v1" && versionHash),
      detail:
        appId && format === "miosa-app/v1" && versionHash
          ? "Durable miosa-app/v1 document and canonical version hash are present."
          : "The server did not return a complete durable miosa-app/v1 document.",
      recovery:
        appId && format === "miosa-app/v1" && versionHash
          ? null
          : "Save the app again through MIOSA App Builder, then rerun doctor.",
    },
    {
      id: "workspace_scope",
      ok: Boolean(
        workspaceId &&
          (!expectedWorkspaceId || workspaceId === expectedWorkspaceId),
      ),
      detail: expectedWorkspaceId
        ? workspaceId === expectedWorkspaceId
          ? `App belongs to selected workspace ${expectedWorkspaceId}.`
          : `App belongs to ${workspaceId ?? "no workspace"}, not ${expectedWorkspaceId}.`
        : workspaceId
          ? `App is bound to workspace ${workspaceId}.`
          : "App has no workspace binding.",
      recovery:
        workspaceId && (!expectedWorkspaceId || workspaceId === expectedWorkspaceId)
          ? null
          : "Select the app's workspace with --workspace or create it in the intended workspace.",
    },
    {
      id: "venue_contract",
      ok:
        viewKind === "generated" ||
        (viewKind === "served" &&
          Boolean(
            stringValue(view, "deploymentId") &&
              stringValue(view, "releaseId"),
          )),
      detail:
        viewKind === "generated"
          ? "Generated UI is eligible only for the jailed preview venue until approved."
          : viewKind === "served"
            ? "Served app pins an exact deployment and release."
            : "App view is missing a valid generated or served venue.",
      recovery:
        viewKind === "generated" ||
        (viewKind === "served" &&
          Boolean(
            stringValue(view, "deploymentId") &&
              stringValue(view, "releaseId"),
          ))
          ? null
          : "Regenerate or republish the app so it records a complete venue.",
    },
    {
      id: "exact_version_review",
      ok:
        !versionApproved ||
        Boolean(versionHash && approvalHash && approvalHash === versionHash),
      detail: versionApproved
        ? approvalHash === versionHash
          ? "Review approval is pinned to the current exact version."
          : "Review approval does not match the current version."
        : "No exact-version review is active. Generated code remains jailed.",
      recovery:
        !versionApproved || approvalHash === versionHash
          ? null
          : "Revoke the stale approval, review the current version, and approve it explicitly.",
    },
    {
      id: "exact_release_publication",
      ok: app["state"] !== "published" || publicationCurrent,
      detail: publicationCurrent
        ? `Current version is bound to release ${publishedReleaseId} in deployment ${publishedDeploymentId}.`
        : app["state"] === "published"
          ? "Published state is missing an exact release binding for the current version."
          : "Current version has not been published.",
      recovery:
        app["state"] !== "published" || publicationCurrent
          ? null
          : "Publish the current reviewed version again and verify the returned release binding.",
    },
    {
      id: "declaration_integrity",
      ok:
        new Set(capabilities).size === capabilities.length &&
        new Set(connectors).size === connectors.length,
      detail:
        new Set(capabilities).size === capabilities.length &&
        new Set(connectors).size === connectors.length
          ? "Capability and connector declarations contain no duplicate grants."
          : "Capability or connector declarations contain duplicates.",
      recovery:
        new Set(capabilities).size === capabilities.length &&
        new Set(connectors).size === connectors.length
          ? null
          : "Remove duplicate declarations and save a new exact version.",
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    app_document_id: appId,
    workspace_id: workspaceId,
    version_hash: versionHash,
    version_approved: versionApproved,
    publication_current: publicationCurrent,
    venue:
      viewKind === "generated" || viewKind === "served" ? viewKind : "invalid",
    capabilities,
    connectors,
    automations,
    checks,
  };
}
