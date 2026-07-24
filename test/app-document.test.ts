import { describe, expect, it } from "vitest";
import { diagnoseAppDocument } from "../src/app-document.js";

describe("diagnoseAppDocument", () => {
  it("accepts a workspace-bound generated app with an exact approval", () => {
    const result = diagnoseAppDocument(
      {
        data: {
          id: "app-1",
          workspace_id: "workspace-1",
          version_hash: "sha256:exact",
          version_approved: true,
          approval: { version_hash: "sha256:exact" },
          document: {
            format: "miosa-app/v1",
            view: { kind: "generated", source: "<main />" },
            capabilities: ["computer.exec"],
            connectors: ["github"],
            automations: [{ id: "daily" }],
          },
        },
      },
      "workspace-1",
    );

    expect(result.ok).toBe(true);
    expect(result.venue).toBe("generated");
    expect(result.automations).toBe(1);
    expect(result.publication_current).toBe(false);
  });

  it("fails a served app that lacks an exact release pin", () => {
    const result = diagnoseAppDocument({
      id: "app-1",
      workspace_id: "workspace-1",
      version_hash: "sha256:exact",
      version_approved: false,
      document: {
        format: "miosa-app/v1",
        view: { kind: "served", deploymentId: "deployment-1" },
        capabilities: [],
        connectors: [],
        automations: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "venue_contract")?.ok,
    ).toBe(false);
  });

  it("detects an approval invalidated by an edit", () => {
    const result = diagnoseAppDocument({
      id: "app-1",
      workspace_id: "workspace-1",
      version_hash: "sha256:new",
      version_approved: true,
      approval: { version_hash: "sha256:old" },
      document: {
        format: "miosa-app/v1",
        view: { kind: "generated", source: "<main />" },
        capabilities: [],
        connectors: [],
        automations: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.id === "exact_version_review")?.ok,
    ).toBe(false);
  });

  it("requires a published app to pin the current exact release", () => {
    const result = diagnoseAppDocument({
      id: "app-1",
      workspace_id: "workspace-1",
      state: "published",
      version_hash: "sha256:exact",
      version_approved: false,
      publication: {
        deployment_id: "deployment-1",
        release_id: "release-1",
        version_hash: "sha256:exact",
      },
      document: {
        format: "miosa-app/v1",
        view: { kind: "generated", source: "<main />" },
        capabilities: [],
        connectors: [],
        automations: [],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.publication_current).toBe(true);
  });
});
