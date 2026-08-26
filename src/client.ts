import { request, type Dispatcher } from "undici";
import type {
  AgentDispatchParams,
  ApiErrorBody,
  BuildId,
  ComputerId,
  ComputerFsEntry,
  ComputerStatResult,
  CreateDeploymentParams,
  Deployment,
  DeploymentBuild,
  DeploymentId,
  EnvVarPreview,
  FsEntry,
  Host,
  HostId,
  Job,
  JobCreateParams,
  MiosaConfig,
  SseEvent,
  Tenant,
  TerminalTicket,
  Tunnel,
  TunnelCreateParams,
  TunnelSlug,
} from "./types.js";
import { AuthError, mapHttpError, NetworkError, UserError } from "./errors.js";
import { assertUsableEndpoint, transportError } from "./endpoint.js";
import { isDebugMode } from "./cli-env.js";
import { CLI_USER_AGENT } from "./version.js";

export class MiosaClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly tenant: string | null;
  private readonly workspace: string | null;

  constructor(config: MiosaConfig) {
    if (!config.api_key) {
      throw new AuthError(
        "You are not logged in. Run: miosa login",
        "Run `miosa login` to authenticate.",
      );
    }
    this.endpoint = config.endpoint.replace(/\/$/, "");
    // Fail on an unusable endpoint here, where the value and its origin are
    // both still known, rather than letting undici raise a bare
    // "TypeError: Invalid URL" from inside the first request.
    assertUsableEndpoint(this.endpoint);
    this.apiKey = config.api_key;
    this.tenant = config.tenant ?? null;
    this.workspace = config.workspace ?? null;
  }

  /** Diagnose a transport failure against the endpoint actually in use. */
  private transport(err: unknown): NetworkError {
    return transportError(err, this.endpoint);
  }

  /** The endpoint this client talks to, for commands that report it. */
  get apiEndpoint(): string {
    return this.endpoint;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CLI_USER_AGENT,
    };

    if (this.tenant) headers["X-MIOSA-Tenant"] = this.tenant;
    if (this.workspace) headers["X-MIOSA-Workspace"] = this.workspace;

    return headers;
  }

  private url(path: string): string {
    return `${this.endpoint}${path}`;
  }

  private async parseError(
    res: Dispatcher.ResponseData,
    method: string,
    path: string,
    sentBody?: unknown,
  ): Promise<never> {
    const rawBody = await res.body.text();
    const requestId = responseHeader(res, "x-request-id");
    let body: ApiErrorBody = {};
    try {
      body = JSON.parse(rawBody) as ApiErrorBody;
    } catch {
      body = { message: rawBody || `HTTP ${res.statusCode}` };
    }
    debugHttpError(method, path, res.statusCode, requestId, rawBody);
    throw mapHttpError(
      res.statusCode,
      body,
      rawBody,
      requestId,
      topLevelKeys(sentBody),
    );
  }

  private async get<T>(path: string): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "GET", path);
    return res.body.json() as Promise<T>;
  }

  private async post<T>(
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "POST",
        headers: { ...this.headers(), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "POST", path, body);
    return res.body.json() as Promise<T>;
  }

  private async delete<T>(path: string): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "DELETE", path);
    if (res.statusCode === 204) return undefined as T;
    return res.body.json() as Promise<T>;
  }

  /** Generic GET for command groups that map directly to stable API routes. */
  async apiGet<T>(path: string): Promise<T> {
    return this.get<T>(path);
  }

  /** Generic binary GET for file/artifact download routes. */
  async apiGetBinary(path: string): Promise<Buffer> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "GET", path);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Generic SSE GET for command groups that stream API events.
   *
   * `accept` exists for routes that may still sit behind a JSON-only
   * content-negotiation plug: sending a list keeps such a route from answering
   * 406 while still asking for the stream first.
   */
  async apiStream(
    path: string,
    accept = "text/event-stream",
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "GET",
        headers: {
          ...this.headers(),
          Accept: accept,
        },
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "GET", path);
    return res;
  }

  /** Generic POST for command groups that map directly to stable API routes. */
  async apiPost<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.post<T>(path, body, headers);
  }

  /** Generic PUT for command groups that map directly to stable API routes. */
  async apiPut<T>(path: string, body?: unknown): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "PUT",
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "PUT", path, body);
    return res.body.json() as Promise<T>;
  }

  /** Generic PATCH for command groups that map directly to stable API routes. */
  async apiPatch<T>(path: string, body?: unknown): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "PATCH",
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "PATCH", path, body);
    return res.body.json() as Promise<T>;
  }

  /** Generic DELETE for command groups that map directly to stable API routes. */
  async apiDelete<T>(path: string): Promise<T> {
    return this.delete<T>(path);
  }

  /** DELETE with the attributable operation metadata returned in response headers. */
  async apiDeleteWithReceipt(
    path: string,
  ): Promise<{ operationId: string; replayed: boolean }> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "DELETE",
        headers: this.headers(),
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "DELETE", path);
    await res.body.dump();
    const operationId = responseHeader(res, "x-forge-operation-id");
    if (!operationId) {
      throw new UserError(
        "Forge delete did not return an operation receipt.",
        "Retry with --debug and contact MIOSA support if the response remains incomplete.",
      );
    }
    return {
      operationId,
      replayed: responseHeader(res, "idempotency-replayed") === "true",
    };
  }

  // --- ClinicIQ / workspace admin SDK helpers ---

  async listWorkspaces(): Promise<unknown[]> {
    return unwrapData<unknown[]>(
      await this.get<unknown>("/api/v1/workspaces"),
      [],
    );
  }

  async createWorkspace(attrs: Record<string, unknown>): Promise<unknown> {
    return unwrapData<unknown>(
      await this.post<unknown>("/api/v1/workspaces", attrs),
    );
  }

  async getWorkspaceInventory(workspaceId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.get<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/inventory`,
      ),
    );
  }

  async cleanupWorkspaceResources(
    workspaceId: string,
    opts: Record<string, unknown>,
  ): Promise<unknown> {
    return unwrapData<unknown>(
      await this.post<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/cleanup`,
        opts,
      ),
    );
  }

  async deleteWorkspace(
    workspaceId: string,
    opts?: { force?: boolean; dryRun?: boolean },
  ): Promise<unknown> {
    const qs = queryString({
      force: opts?.force,
      dry_run: opts?.dryRun,
    });
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}${qs}`,
      ),
    );
  }

  async listComputers(params?: {
    workspace?: string;
    workspace_id?: string;
    state?: string;
    limit?: number;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/computers${queryString(paramsToApi(params))}`,
      ),
      ["computers", "data"],
    );
  }

  async deleteComputer(computerId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/computers/${encodeURIComponent(computerId)}`,
      ),
    );
  }

  async listSandboxes(params?: {
    workspace?: string;
    workspace_id?: string;
    state?: string;
    limit?: number;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/sandboxes${queryString(paramsToApi(params))}`,
      ),
    );
  }

  async deleteSandbox(sandboxId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
      ),
    );
  }

  async listDomains(params?: {
    workspace?: string;
    workspace_id?: string;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/custom-domains${queryString(paramsToApi(params))}`,
      ),
    );
  }

  async deleteDomain(hostnameOrId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/domains/${encodeURIComponent(hostnameOrId)}`,
      ),
    );
  }

  async listDatabases(params?: {
    workspace?: string;
    workspace_id?: string;
    state?: string;
    limit?: number;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/databases${queryString(paramsToApi(params))}`,
      ),
    );
  }

  async deleteDatabase(databaseId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/databases/${encodeURIComponent(databaseId)}`,
      ),
    );
  }

  async listSecretsMetadata(params?: {
    workspace?: string;
    workspace_id?: string;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/egress/secrets${queryString(paramsToApi(params))}`,
      ),
    );
  }

  async unsetSecret(secretId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/egress/secrets/${encodeURIComponent(secretId)}`,
      ),
    );
  }

  async listStorageBuckets(params?: {
    workspace?: string;
    workspace_id?: string;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/storage/buckets${queryString(paramsToApi(params))}`,
      ),
    );
  }

  async deleteStorageBucket(bucketId: string): Promise<unknown> {
    return unwrapData<unknown>(
      await this.delete<unknown>(
        `/api/v1/storage/buckets/${encodeURIComponent(bucketId)}`,
      ),
    );
  }

  async getAuditEvents(params?: {
    workspace?: string;
    workspace_id?: string;
    limit?: number;
    before?: string;
  }): Promise<unknown[]> {
    return unwrapList(
      await this.get<unknown>(
        `/api/v1/audit-log${queryString(paramsToApi(params))}`,
      ),
    );
  }

  // --- Tenant ---

  async getTenant(): Promise<Tenant> {
    const response = await this.get<
      { data?: unknown; tenant?: unknown } & Record<string, unknown>
    >("/api/v1/platform/tenants/current");

    const tenant = normalizeTenantResponse(response);
    const billingOverview = await this.getBillingOverview().catch(() => null);
    const billingCreditBalance =
      billingOverview?.available_balance_cents ??
      (billingOverview
        ? Math.max(
            0,
            (billingOverview.usage_budget_cents ?? 0) +
              (billingOverview.topup_balance_cents ?? 0) -
              (billingOverview.billing_period_usage_cents ?? 0),
          )
        : null);

    return {
      ...tenant,
      plan: tenant.plan ?? (tenant as { plan_name?: string }).plan_name ?? null,
      credit_balance: billingCreditBalance ?? tenant.credit_balance ?? 0,
    };
  }

  private async getBillingOverview(): Promise<{
    available_balance_cents?: number | null;
    usage_budget_cents?: number | null;
    topup_balance_cents?: number | null;
    billing_period_usage_cents?: number | null;
  }> {
    const response = await this.get<{
      data?: {
        available_balance_cents?: number | null;
        usage_budget_cents?: number | null;
        topup_balance_cents?: number | null;
        billing_period_usage_cents?: number | null;
      };
      available_balance_cents?: number | null;
      usage_budget_cents?: number | null;
      topup_balance_cents?: number | null;
      billing_period_usage_cents?: number | null;
    }>("/api/v1/billing/overview");

    return response.data ?? response;
  }

  // --- Hosts ---

  async listHosts(): Promise<Host[]> {
    return this.get<{ data: Host[] }>("/api/v1/opencomputers/hosts").then(
      (r) => r.data ?? [],
    );
  }

  async getHost(idOrName: string): Promise<Host> {
    // Try by ID first; if 404 fallback to name search
    try {
      return await this.get<{ data: Host }>(
        `/api/v1/opencomputers/hosts/${encodeURIComponent(idOrName)}`,
      ).then((r) => r.data);
    } catch {
      // Fallback: search by name
      const hosts = await this.listHosts();
      const match = hosts.find((h) => h.name === idOrName || h.id === idOrName);
      if (!match) {
        const { UserError } = await import("./errors.js");
        const hint = /^(sbx_|sb_)/.test(idOrName)
          ? "This looks like a sandbox id. Use `miosa sandbox ls` / `miosa sandbox cp` for sandboxes."
          : "Run `miosa hosts` to list available fleet hosts.";
        throw new UserError(`Host not found: ${idOrName}`, hint);
      }
      return match;
    }
  }

  async createHost(params: { name: string; platform?: string }): Promise<Host> {
    return this.post<{ data: Host }>(
      "/api/v1/opencomputers/hosts",
      params,
    ).then((r) => r.data);
  }

  // --- Terminal ---

  async getTerminalTicket(hostId: HostId): Promise<TerminalTicket> {
    return this.post<{ data: TerminalTicket }>(
      `/api/v1/opencomputers/hosts/${hostId}/terminal/ticket`,
    ).then((r) => r.data);
  }

  // --- Jobs ---

  async createJob(hostId: HostId, params: JobCreateParams): Promise<Job> {
    return this.post<{ data: Job }>(
      `/api/v1/opencomputers/hosts/${hostId}/jobs`,
      params,
    ).then((r) => r.data);
  }

  /** Returns a raw Response for SSE streaming */
  async streamJob(
    hostId: HostId,
    params: JobCreateParams,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/opencomputers/hosts/${hostId}/jobs`),
        {
          method: "POST",
          headers: {
            ...this.headers(),
            Accept: "text/event-stream",
          },
          body: JSON.stringify({ ...params, stream: true }),
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "POST",
        `/api/v1/opencomputers/hosts/${hostId}/jobs`,
      );
    }
    return res;
  }

  // --- Filesystem ---

  async listFs(hostId: HostId, path: string): Promise<FsEntry[]> {
    return this.get<{ data: FsEntry[] }>(
      `/api/v1/opencomputers/hosts/${hostId}/fs?path=${encodeURIComponent(path)}`,
    ).then((r) => r.data);
  }

  async downloadFile(
    hostId: HostId,
    remotePath: string,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(
          `/api/v1/opencomputers/hosts/${hostId}/fs/content?path=${encodeURIComponent(remotePath)}`,
        ),
        { method: "GET", headers: this.headers() },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/opencomputers/hosts/${hostId}/fs/content`,
      );
    }
    return res;
  }

  async uploadFile(
    hostId: HostId,
    remotePath: string,
    data: Buffer,
    filename: string,
  ): Promise<void> {
    const boundary = `----MiosaUpload${Date.now()}`;
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(header),
      data,
      Buffer.from(footer),
    ]);

    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/opencomputers/hosts/${hostId}/fs/content`),
        {
          method: "POST",
          headers: {
            ...this.headers(),
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "X-Remote-Path": remotePath,
          },
          body,
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      await this.parseError(
        res,
        "POST",
        `/api/v1/opencomputers/hosts/${hostId}/fs/content`,
      );
    }
    await res.body.dump();
  }

  async deleteFs(
    hostId: HostId,
    path: string,
    recursive: boolean,
  ): Promise<void> {
    await this.delete<void>(
      `/api/v1/opencomputers/hosts/${hostId}/fs?path=${encodeURIComponent(path)}&recursive=${recursive}`,
    );
  }

  // --- Computers (Firecracker microVMs) filesystem ---

  async computerListFiles(
    computerId: ComputerId,
    remotePath: string,
  ): Promise<ComputerFsEntry[]> {
    return this.get<{ data: ComputerFsEntry[] }>(
      `/api/v1/computers/${computerId}/files?path=${encodeURIComponent(remotePath)}`,
    ).then((r) => r.data);
  }

  async computerWriteFile(
    computerId: ComputerId,
    remotePath: string,
    content: Buffer | string,
  ): Promise<void> {
    const body =
      content instanceof Buffer ? content.toString("base64") : content;
    await this.post<void>(`/api/v1/computers/${computerId}/files/write`, {
      path: remotePath,
      content: body,
      encoding: content instanceof Buffer ? "base64" : "utf8",
    });
  }

  async computerDownloadFile(
    computerId: ComputerId,
    remotePath: string,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(
          `/api/v1/computers/${computerId}/files/download?path=${encodeURIComponent(remotePath)}`,
        ),
        { method: "GET", headers: this.headers() },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/computers/${computerId}/files/download`,
      );
    }
    return res;
  }

  async computerUploadFile(
    computerId: ComputerId,
    remotePath: string,
    data: Buffer,
    filename: string,
  ): Promise<void> {
    const boundary = `----MiosaComputerUpload${Date.now()}`;
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(header),
      data,
      Buffer.from(footer),
    ]);

    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/computers/${computerId}/files/upload`),
        {
          method: "POST",
          headers: {
            ...this.headers(),
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "X-Remote-Path": remotePath,
          },
          body,
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      await this.parseError(
        res,
        "POST",
        `/api/v1/computers/${computerId}/files/upload`,
      );
    }
    await res.body.dump();
  }

  async computerMkdir(
    computerId: ComputerId,
    remotePath: string,
  ): Promise<void> {
    await this.post<void>(`/api/v1/computers/${computerId}/files/mkdir`, {
      path: remotePath,
    });
  }

  async computerDeleteFile(
    computerId: ComputerId,
    remotePath: string,
  ): Promise<void> {
    await this.delete<void>(
      `/api/v1/computers/${computerId}/files?path=${encodeURIComponent(remotePath)}`,
    );
  }

  async computerStat(
    computerId: ComputerId,
    remotePath: string,
  ): Promise<ComputerStatResult> {
    return this.post<{ data: ComputerStatResult }>(
      `/api/v1/computers/${computerId}/files/stat`,
      { path: remotePath },
    ).then((r) => r.data);
  }

  // --- Computers exec ---

  async computerExec(
    computerId: ComputerId,
    command: string,
    opts?: { language?: "shell" | "python" },
  ): Promise<Dispatcher.ResponseData> {
    const path =
      opts?.language === "python"
        ? `/api/v1/computers/${computerId}/exec/python`
        : `/api/v1/computers/${computerId}/exec`;
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "POST",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ command }),
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) return this.parseError(res, "POST", path);
    return res;
  }

  // --- Tunnels ---

  async listTunnels(hostId: HostId): Promise<Tunnel[]> {
    return this.get<{ data: Tunnel[] }>(
      `/api/v1/opencomputers/hosts/${hostId}/tunnels`,
    ).then((r) => r.data);
  }

  async createTunnel(
    hostId: HostId,
    params: TunnelCreateParams,
  ): Promise<Tunnel> {
    return this.post<{ data: Tunnel }>(
      `/api/v1/opencomputers/hosts/${hostId}/tunnels`,
      params,
    ).then((r) => r.data);
  }

  async closeTunnel(hostId: HostId, slug: TunnelSlug): Promise<void> {
    await this.delete<void>(
      `/api/v1/opencomputers/hosts/${hostId}/tunnels/${slug}`,
    );
  }

  // --- Agent ---

  async dispatchAgent(
    hostId: HostId,
    params: AgentDispatchParams,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/opencomputers/hosts/${hostId}/agent/dispatch`),
        {
          method: "POST",
          headers: {
            ...this.headers(),
            Accept: "text/event-stream",
          },
          body: JSON.stringify(params),
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "POST",
        `/api/v1/opencomputers/hosts/${hostId}/agent/dispatch`,
      );
    }
    return res;
  }

  // --- Deployments ---

  async listDeployments(params?: {
    state?: string;
    workspace?: string;
    workspace_id?: string;
    limit?: number;
  }): Promise<Deployment[]> {
    const qs = new URLSearchParams();
    if (params?.state) qs.set("state", params.state);
    const workspaceId = params?.workspace_id ?? params?.workspace;
    if (workspaceId) qs.set("workspace_id", workspaceId);
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";

    return this.get<{ data: Deployment[] }>(
      `/api/v1/deployments${suffix}`,
    ).then((r) => r.data);
  }

  async getDeployment(id: DeploymentId): Promise<Deployment> {
    return this.get<{ data: Deployment }>(
      `/api/v1/deployments/${encodeURIComponent(id)}`,
    ).then((r) => r.data);
  }

  async createDeployment(
    params: CreateDeploymentParams,
  ): Promise<{ data: Deployment; webhook_secret: string }> {
    return this.post<{ data: Deployment; webhook_secret: string }>(
      "/api/v1/deployments",
      params,
    );
  }

  async deleteDeployment(
    id: DeploymentId,
  ): Promise<{ id: string; deleted: boolean }> {
    return this.delete<{ id: string; deleted: boolean }>(
      `/api/v1/deployments/${encodeURIComponent(id)}`,
    );
  }

  async redeployDeployment(id: DeploymentId): Promise<DeploymentBuild> {
    return this.post<{ data: DeploymentBuild }>(
      `/api/v1/deployments/${encodeURIComponent(id)}/redeploy`,
    ).then((r) => r.data);
  }

  async listBuilds(id: DeploymentId): Promise<DeploymentBuild[]> {
    return this.get<{ data: DeploymentBuild[] }>(
      `/api/v1/deployments/${encodeURIComponent(id)}/builds`,
    ).then((r) => r.data);
  }

  async getBuild(id: DeploymentId, bid: BuildId): Promise<DeploymentBuild> {
    return this.get<{ data: DeploymentBuild }>(
      `/api/v1/deployments/${encodeURIComponent(id)}/builds/${encodeURIComponent(bid)}`,
    ).then((r) => r.data);
  }

  /** Returns a raw SSE Response for deployment log streaming */
  async streamDeploymentLogs(
    id: DeploymentId,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/deployments/${encodeURIComponent(id)}/logs`),
        {
          method: "GET",
          headers: {
            ...this.headers(),
            Accept: "text/event-stream",
          },
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/deployments/${encodeURIComponent(id)}/logs`,
      );
    }
    return res;
  }

  /** Returns a raw SSE Response for build log streaming */
  async streamBuildLogs(
    id: DeploymentId,
    buildId: BuildId,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(
          `/api/v1/deployments/${encodeURIComponent(id)}/builds/${encodeURIComponent(buildId)}/logs`,
        ),
        {
          method: "GET",
          headers: {
            ...this.headers(),
            Accept: "text/event-stream",
          },
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/deployments/${encodeURIComponent(id)}/builds/${encodeURIComponent(buildId)}/logs`,
      );
    }
    return res;
  }

  async getDeploymentEnv(id: DeploymentId): Promise<EnvVarPreview[]> {
    return this.get<{ data: EnvVarPreview[] }>(
      `/api/v1/deployments/${encodeURIComponent(id)}/env`,
    ).then((r) => r.data);
  }

  async setDeploymentEnv(
    id: DeploymentId,
    env: Record<string, string>,
  ): Promise<EnvVarPreview[]> {
    return this.post<{ data: EnvVarPreview[] }>(
      `/api/v1/deployments/${encodeURIComponent(id)}/env`,
      { env },
    ).then((r) => r.data);
  }

  // --- Watch ---

  async watchEvents(hostId: HostId): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(
        this.url(`/api/v1/opencomputers/hosts/${hostId}/events`),
        {
          method: "GET",
          headers: {
            ...this.headers(),
            Accept: "text/event-stream",
          },
        },
      );
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/opencomputers/hosts/${hostId}/events`,
      );
    }
    return res;
  }

  /** Open an SSE event stream for a Computer (Firecracker microVM). */
  async watchComputerEvents(
    computerId: ComputerId,
  ): Promise<Dispatcher.ResponseData> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(`/api/v1/computers/${computerId}/events`), {
        method: "GET",
        headers: {
          ...this.headers(),
          Accept: "text/event-stream",
        },
      });
    } catch (err) {
      throw this.transport(err);
    }
    if (res.statusCode >= 400) {
      return this.parseError(
        res,
        "GET",
        `/api/v1/computers/${computerId}/events`,
      );
    }
    return res;
  }
}

function normalizeTenantResponse(
  response: { data?: unknown; tenant?: unknown } & Record<string, unknown>,
): Tenant {
  const candidate = response.data ?? response.tenant ?? response;

  if (!isRecord(candidate)) {
    throw malformedTenantError();
  }

  const name = stringField(candidate, "name");
  const slug = stringField(candidate, "slug");

  if (!name || !slug) {
    throw malformedTenantError();
  }

  return candidate as unknown as Tenant;
}

function malformedTenantError(): UserError {
  return new UserError(
    "MIOSA returned an invalid account response.",
    "Run `miosa status --json` and try `miosa login` again. If this persists, contact MIOSA support with --debug output.",
  );
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function responseHeader(
  res: Dispatcher.ResponseData,
  name: string,
): string | null {
  const headers = res.headers as
    | Record<string, string | string[] | undefined>
    | Array<string | Buffer>
    | undefined;

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = String(headers[i] ?? "").toLowerCase();
      if (key === name.toLowerCase()) return String(headers[i + 1] ?? "");
    }
    return null;
  }

  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function unwrapData<T>(payload: unknown, fallback?: T): T {
  if (isRecord(payload) && "data" in payload) return payload["data"] as T;
  if (payload === undefined && fallback !== undefined) return fallback;
  return payload as T;
}

function unwrapList(payload: unknown, keys: string[] = ["data"]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function queryString(values?: Record<string, unknown>): string {
  if (!values) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (
      value === undefined ||
      value === null ||
      value === false ||
      value === ""
    )
      continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function paramsToApi<
  T extends { workspace?: string; workspace_id?: string } | undefined,
>(params: T): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const result: Record<string, unknown> = { ...params };
  if (params.workspace && !params.workspace_id)
    result["workspace_id"] = params.workspace;
  delete result["workspace"];
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function debugHttpError(
  method: string,
  path: string,
  status: number,
  requestId: string | null,
  rawBody: string,
): void {
  if (!isDebugMode()) return;

  const requestIdText = requestId ? ` request_id=${requestId}` : "";
  process.stderr.write(
    `[debug] ${method} ${path} -> HTTP ${status}${requestIdText}\n`,
  );

  if (rawBody) {
    process.stderr.write(`[debug] response_body=${rawBody}\n`);
  }
}

/**
 * Top-level keys of a JSON request body. Used to tell a field the CLI actually
 * sent apart from a field the server attributed an error to on its own.
 */
function topLevelKeys(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return [];
  return Object.keys(body as Record<string, unknown>);
}

/**
 * SSE parser — consumes an undici body stream and yields parsed events.
 *
 * Frame state (`event:` name and accumulated `data:` lines) is held across
 * chunk boundaries. It used to be declared inside the chunk loop, so a frame
 * split by the transport lost its accumulated state: an `event:`/`data:` pair
 * arriving in separate chunks lost the event name, and a frame whose
 * terminating blank line landed in the next chunk was dropped outright. The
 * server writes each frame with one `Plug.Conn.chunk/2` call, but a TLS record
 * boundary or a reverse proxy can split it anywhere (2026-08-26).
 */
export async function* parseSse(
  body: Dispatcher.ResponseData["body"],
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  for await (const chunk of body) {
    // Streaming decode: a multi-byte character split across chunks would be
    // corrupted by a per-chunk toString().
    buffer += decoder.decode(
      chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)),
      { stream: true },
    );

    // SSE line terminators are \n, \r\n, or a bare \r.
    const lines = buffer.split(/\r\n|\r|\n/);
    // Keep the last, possibly incomplete, line for the next chunk.
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
        if (dataLines.length > 0) {
          yield parseSseEvent(eventType, dataLines.join("\n"));
        }
        eventType = "";
        dataLines = [];
      } else if (line.startsWith(":")) {
        // Comment frame, e.g. the server's ":heartbeat". Ignored per spec.
        continue;
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Spec: strip exactly one leading space, keep the rest verbatim so log
        // indentation survives.
        dataLines.push(stripOneLeadingSpace(line.slice(5)));
      }
    }
  }

  // A server that closes right after its last frame without the terminating
  // blank line would otherwise lose that frame.
  buffer += decoder.decode();
  if (buffer !== "") {
    if (buffer.startsWith("data:")) {
      dataLines.push(stripOneLeadingSpace(buffer.slice(5)));
    } else if (buffer.startsWith("event:")) {
      eventType = buffer.slice(6).trim();
    }
  }
  if (dataLines.length > 0) {
    yield parseSseEvent(eventType, dataLines.join("\n"));
  }
}

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseSseEvent(eventType: string, raw: string): SseEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownEvent(eventType, raw);
  }

  const data = parsed as Record<string, unknown>;

  // Normalize event type from field or explicit event: line
  const type =
    eventType || (typeof data["type"] === "string" ? data["type"] : "unknown");

  switch (type) {
    case "stdout":
      return {
        type: "stdout",
        data: String(data["data"] ?? data["output"] ?? ""),
      };
    case "stderr":
      return {
        type: "stderr",
        data: String(data["data"] ?? data["output"] ?? ""),
      };
    case "exit":
      return {
        type: "exit",
        exit_code: Number(data["exit_code"] ?? data["code"] ?? 0),
      };
    case "error":
      return { type: "error", message: String(data["message"] ?? raw) };
    case "thought":
      return {
        type: "thought",
        content: String(data["content"] ?? data["thought"] ?? ""),
      };
    case "tool_call":
      return {
        type: "tool_call",
        tool: String(data["tool"] ?? ""),
        input: data["input"],
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool: String(data["tool"] ?? ""),
        output: data["output"],
      };
    case "done":
      return { type: "done", result: data["result"] };
    case "heartbeat":
    case "ping":
      return { type: "heartbeat" };
    default:
      return unknownEvent(eventType, raw);
  }
}

/**
 * Preserve the stream's `event:` name on frames with no dedicated variant.
 * Discarding it meant every `event: build_event` frame arrived as an untyped
 * blob and consumers could not tell one server event from another.
 */
function unknownEvent(eventType: string, raw: string): SseEvent {
  return eventType === ""
    ? { type: "unknown", raw }
    : { type: "unknown", event: eventType, raw };
}
