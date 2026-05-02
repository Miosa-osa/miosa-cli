import { request, type Dispatcher } from "undici";
import type {
  AgentDispatchParams,
  ApiErrorBody,
  BuildId,
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
import { AuthError, mapHttpError, NetworkError } from "./errors.js";

export class MiosaClient {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(config: MiosaConfig) {
    if (!config.api_key) {
      throw new AuthError(
        "You are not logged in. Run: miosa auth login",
        "Install with `brew install Miosa-osa/tap/miosa`, then run `miosa auth login`.",
      );
    }
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiKey = config.api_key;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `@miosa/cli/0.1.0`,
    };
  }

  private url(path: string): string {
    return `${this.endpoint}${path}`;
  }

  private async parseError(res: Dispatcher.ResponseData): Promise<never> {
    const rawBody = await res.body.text();
    let body: ApiErrorBody = {};
    try {
      body = JSON.parse(rawBody) as ApiErrorBody;
    } catch {
      body = { message: rawBody || `HTTP ${res.statusCode}` };
    }
    throw mapHttpError(res.statusCode, body, rawBody);
  }

  private async get<T>(path: string): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "GET",
        headers: this.headers(),
      });
    } catch (err) {
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        "Check your connection and endpoint: miosa status",
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
    return res.body.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    let res: Dispatcher.ResponseData;
    try {
      res = await request(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        "Check your connection and endpoint: miosa status",
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
    if (res.statusCode === 204) return undefined as T;
    return res.body.json() as Promise<T>;
  }

  /** Generic GET for command groups that map directly to stable API routes. */
  async apiGet<T>(path: string): Promise<T> {
    return this.get<T>(path);
  }

  /** Generic POST for command groups that map directly to stable API routes. */
  async apiPost<T>(path: string, body?: unknown): Promise<T> {
    return this.post<T>(path, body);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        "Check your connection and endpoint: miosa status",
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
    return res.body.json() as Promise<T>;
  }

  /** Generic DELETE for command groups that map directly to stable API routes. */
  async apiDelete<T>(path: string): Promise<T> {
    return this.delete<T>(path);
  }

  // --- Tenant ---

  async getTenant(): Promise<Tenant> {
    return this.get<{ data: Tenant }>("/api/v1/platform/tenants/current").then(
      (r) => r.data,
    );
  }

  // --- Hosts ---

  async listHosts(): Promise<Host[]> {
    return this.get<{ data: Host[] }>("/api/v1/opencomputers/hosts").then(
      (r) => r.data,
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
        throw new UserError(`Host not found: ${idOrName}`);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
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
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "X-Remote-Path": remotePath,
            "User-Agent": `@miosa/cli/0.1.0`,
          },
          body,
        },
      );
    } catch (err) {
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) await this.parseError(res);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
    return res;
  }

  // --- Deployments ---

  async listDeployments(): Promise<Deployment[]> {
    return this.get<{ data: Deployment[] }>("/api/v1/deployments").then(
      (r) => r.data,
    );
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
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
      throw new NetworkError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.statusCode >= 400) return this.parseError(res);
    return res;
  }
}

// SSE parser — consumes undici body stream, yields parsed events
export async function* parseSse(
  body: Dispatcher.ResponseData["body"],
): AsyncGenerator<SseEvent> {
  let buffer = "";

  for await (const chunk of body) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    // Keep last potentially incomplete line
    buffer = lines.pop() ?? "";

    let eventType = "";
    let dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      } else if (line === "") {
        // Dispatch event
        if (dataLines.length > 0) {
          const raw = dataLines.join("\n");
          yield parseSseEvent(eventType, raw);
        }
        eventType = "";
        dataLines = [];
      }
    }
  }
}

function parseSseEvent(eventType: string, raw: string): SseEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "unknown", raw };
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
      return { type: "unknown", raw };
  }
}
