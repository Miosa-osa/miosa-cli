import { createHash } from "node:crypto";
import type { MiosaClient } from "./client.js";
import { ACTION_CAPABILITY_IDENTITIES } from "./generated/action-capabilities.js";

export { ACTION_CAPABILITY_IDENTITIES } from "./generated/action-capabilities.js";

export interface ActionCapability {
  name: string;
  version: string;
  fingerprint: string;
  risk: "read" | "write" | "destructive";
  scope: "tenant" | "workspace" | "computer" | "deployment";
  approval: "never" | "policy" | "always";
}

export interface ActionAuthorityDecision {
  decision: "allow" | "deny" | "pending_approval";
  capability?: ActionCapability;
  approval_request_id?: string;
  receipt_id?: string;
  reason?: string;
}

export interface ActionAuthorityRequest {
  capability: Pick<ActionCapability, "name" | "fingerprint">;
  request_fingerprint: string;
  params_fingerprint: string;
  surface: string;
  workspace_id?: string;
}

export interface ActionApproval {
  id: string;
  capability_name: string;
  capability_fingerprint: string;
  request_fingerprint: string;
  principal_type: string;
  principal_id: string;
  status: string;
  workspace_id?: string | null;
  expires_at?: string | null;
  resolved_at?: string | null;
  consumed_at?: string | null;
  inserted_at: string;
}

export interface ActionGrant {
  id: string;
  capability_name: string;
  capability_fingerprint: string;
  principal_type: string;
  principal_id: string;
  status: string;
  workspace_id?: string | null;
  constraints: Record<string, unknown>;
  expires_at?: string | null;
  revoked_at?: string | null;
  inserted_at: string;
}

export interface ActionReceipt {
  id: string;
  capability_name: string;
  capability_fingerprint: string;
  principal_type: string;
  principal_id: string;
  surface: string;
  decision: string;
  params_fingerprint: string;
  grant_id?: string | null;
  approval_request_id?: string | null;
  occurred_at: string;
}

interface DataEnvelope<T> {
  data: T;
}

export interface ActionCatalogConformance {
  ok: boolean;
  missing: string[];
  stale: string[];
  unexpected: string[];
}

export function actionCatalogConformance(
  liveCatalog: ActionCapability[],
): ActionCatalogConformance {
  const expected = new Map<
    string,
    { name: string; version: string; fingerprint: string }
  >(
    ACTION_CAPABILITY_IDENTITIES.map((identity) => [identity.name, identity]),
  );
  const live = new Map(liveCatalog.map((capability) => [capability.name, capability]));

  const missing = [...expected.keys()].filter((name) => !live.has(name));
  const stale = [...expected.entries()]
    .filter(([name, identity]) => {
      const capability = live.get(name);
      return (
        capability !== undefined &&
        (capability.version !== identity.version ||
          capability.fingerprint !== identity.fingerprint)
      );
    })
    .map(([name]) => name);
  const unexpected = [...live.keys()].filter((name) => !expected.has(name));

  return {
    ok: missing.length === 0 && stale.length === 0 && unexpected.length === 0,
    missing,
    stale,
    unexpected,
  };
}

export class ActionAuthorityClient {
  constructor(private readonly client: MiosaClient) {}

  async catalog(): Promise<ActionCapability[]> {
    const response = await this.client.apiGet<DataEnvelope<ActionCapability[]>>(
      "/api/v1/actions/catalog",
    );
    return response.data;
  }

  async authorize(
    name: string,
    params: unknown,
    options: {
      surface?: string;
      workspaceId?: string;
      invocationId?: string;
    } = {},
  ): Promise<ActionAuthorityDecision> {
    const capability = await this.requireCapability(name);
    const paramsFingerprint = fingerprint(params);
    const invocation = {
      capability: capability.fingerprint,
      params: paramsFingerprint,
      workspace_id: options.workspaceId ?? null,
      invocation_id: options.invocationId ?? null,
    };

    const request: ActionAuthorityRequest = {
      capability: {
        name: capability.name,
        fingerprint: capability.fingerprint,
      },
      request_fingerprint: fingerprint(invocation),
      params_fingerprint: paramsFingerprint,
      surface: options.surface ?? "cli",
      ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
    };

    return this.client.apiPost<ActionAuthorityDecision>(
      "/api/v1/actions/authorize",
      request,
    );
  }

  async approvals(status?: string): Promise<ActionApproval[]> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await this.client.apiGet<DataEnvelope<ActionApproval[]>>(
      `/api/v1/actions/approvals${suffix}`,
    );
    return response.data;
  }

  async resolveApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ActionApproval> {
    const response = await this.client.apiPost<DataEnvelope<ActionApproval>>(
      `/api/v1/actions/approvals/${encodeURIComponent(id)}/${decision}`,
    );
    return response.data;
  }

  async grants(status?: string): Promise<ActionGrant[]> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await this.client.apiGet<DataEnvelope<ActionGrant[]>>(
      `/api/v1/actions/grants${suffix}`,
    );
    return response.data;
  }

  async createGrant(input: {
    capability: Pick<ActionCapability, "name" | "fingerprint">;
    principal_type: string;
    principal_id: string;
    workspace_id?: string;
    expires_at?: string;
    constraints?: Record<string, unknown>;
  }): Promise<ActionGrant> {
    const response = await this.client.apiPost<DataEnvelope<ActionGrant>>(
      "/api/v1/actions/grants",
      input,
    );
    return response.data;
  }

  async revokeGrant(id: string): Promise<ActionGrant> {
    const response = await this.client.apiDelete<DataEnvelope<ActionGrant>>(
      `/api/v1/actions/grants/${encodeURIComponent(id)}`,
    );
    return response.data;
  }

  async receipts(limit = 100): Promise<ActionReceipt[]> {
    const response = await this.client.apiGet<DataEnvelope<ActionReceipt[]>>(
      `/api/v1/actions/receipts?limit=${limit}`,
    );
    return response.data;
  }

  async requireCapability(name: string): Promise<ActionCapability> {
    const capability = (await this.catalog()).find((item) => item.name === name);
    if (!capability) {
      throw new Error(
        `Capability ${name} is not registered by this MIOSA control plane.`,
      );
    }
    return capability;
  }
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("Authority fingerprints cannot contain undefined.");
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
