import fs from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import { client, enc, runAction, type JsonOptions } from "./enterprise-util.js";
import { printJson } from "./util.js";
import { renderTable } from "../ui/table.js";
import { spin } from "../ui/spinner.js";

type ConnectorRecord = {
  id?: string;
  uid?: string;
  provider?: string;
  type?: string;
  display_name?: string;
  status?: string;
  created_at?: string;
  inserted_at?: string;
};

type ConnectorCreateOptions = JsonOptions & {
  type?: string;
  name?: string;
  uid?: string;
  scope?: string;
  workspace?: string;
  value?: string;
  stdin?: boolean;
  file?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorListOptions = JsonOptions & {
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorTokenOptions = JsonOptions & {
  subject?: string;
  installationId?: string;
  project?: string;
  environment?: string;
  resourceType?: string;
  resourceId?: string;
  scope?: string[];
  audience?: string[];
  validityBufferMs?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorOauthStartOptions = JsonOptions & {
  scope?: string;
  exposeAsEnv?: boolean;
  ownerUserId?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorLinkListOptions = JsonOptions & {
  workspace?: string;
  project?: string;
  connectorId?: string;
  environment?: string;
  status?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorProjectLinkCreateOptions = JsonOptions & {
  connectorId?: string;
  installationId?: string;
  workspace?: string;
  project?: string;
  environment?: string;
  resourceType?: string;
  resourceId?: string;
  subject?: string[];
  scope?: string[];
  mode?: string;
  effect?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorTriggerCreateOptions = JsonOptions & {
  connectorId?: string;
  workspace?: string;
  project?: string;
  environment?: string;
  destinationPath?: string;
  destinationUrl?: string;
  eventType?: string[];
  status?: string;
  providerAdapter?: string;
  webhookSigningSecret?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorTriggerDeliveryOptions = ConnectorLinkListOptions & {
  trigger?: string;
  state?: string;
  eventType?: string;
};

type ConnectorDefaultListOptions = ConnectorLinkListOptions & {
  defaultScope?: string;
  target?: string;
};

type ConnectorApplicableDefaultOptions = JsonOptions & {
  workspace?: string;
  project?: string;
  environment?: string;
  target?: string;
  resourceType?: string;
  resourceId?: string;
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
};

type ConnectorMaterializeDefaultOptions = ConnectorApplicableDefaultOptions & {
  env?: string;
};

type ConnectorDefaultCreateOptions = ConnectorProjectLinkCreateOptions & {
  defaultScope?: string;
  target?: string;
};

export function register(program: Command): void {
  const connectors = program
    .command("connectors")
    .alias("provider")
    .description("Manage MIOSA Connect provider connectors and runtime tokens");

  connectors
    .command("list")
    .description("List Connect provider connectors")
    .option("--external-workspace-id <id>", "Filter by white-label workspace attribution")
    .option("--external-user-id <id>", "Filter by white-label user attribution")
    .option("--external-project-id <id>", "Filter by white-label project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorListOptions) =>
      runAction(async () => {
        const spinner = isJson(opts) ? null : spin("Fetching connectors...");
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/connectors${queryString(externalAttribution(opts))}`,
        );
        spinner?.stop();
        const rows = unwrapList<ConnectorRecord>(raw);

        if (isJson(opts)) {
          printJson(rows);
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim("No connectors configured."));
          return;
        }

        renderTable(rows, [
          { header: "UID", key: (row) => row.uid ?? row.id ?? "", width: 34 },
          { header: "PROVIDER", key: (row) => row.provider ?? "", width: 14 },
          { header: "TYPE", key: (row) => row.type ?? "", width: 12 },
          { header: "STATUS", key: (row) => row.status ?? "", width: 12 },
        ]);
      }),
    );

  connectors
    .command("show <connector>")
    .description("Show a Connect provider connector")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/connectors/${enc(connector)}`,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  connectors
    .command("create <provider>")
    .description("Create an API-key backed Connect provider connector")
    .option("--type <type>", "Connector type", "api-key")
    .option("--name <name>", "Stable connector name, e.g. workspace-claude")
    .option("--uid <uid>", "Full connector UID, e.g. anthropic/workspace-claude")
    .option("--scope <scope>", "Credential scope: tenant, workspace, user")
    .option("--workspace <id>", "Workspace ID for workspace-scoped connector")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--value <value>", "Provider credential value")
    .option("--stdin", "Read provider credential from stdin")
    .option("--file <path>", "Read provider credential from a local file")
    .option("--json", "Output as JSON")
    .action((provider: string, opts: ConnectorCreateOptions) =>
      runAction(async () => {
        const credentialValue = await readCredentialValue(opts);
        const uid = opts.uid ?? `${provider}/${opts.name ?? "default"}`;
        const body: Record<string, unknown> = {
          provider,
          type: normalizeMode(opts.type ?? "api-key"),
          uid,
          scope: opts.scope ?? (opts.workspace ? "workspace" : "tenant"),
          workspace_id: opts.workspace,
          ...externalAttribution(opts),
          credential: {
            field: "api_key",
            value: credentialValue,
          },
        };

        const spinner = isJson(opts) ? null : spin(`Creating connector ${uid}...`);
        const raw = await client().apiPost<unknown>("/api/v1/connect/connectors", body);
        spinner?.succeed(`Created connector ${uid}`);
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  connectors
    .command("token <connector>")
    .description("Request a short-lived runtime provider token")
    .option("--subject <subject>", "app, user:<id>, or jwt-bearer:<sub>", "app")
    .option("--installation-id <id>", "Provider installation ID")
    .option("--project <id>", "Project ID for project-scoped connector access")
    .option("--environment <name>", "Project environment", "development")
    .option("--resource-type <type>", "Optional runtime resource type: sandbox, computer, deployment")
    .option("--resource-id <id>", "Optional runtime resource ID")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--scope <scope>", "Provider scope. Repeatable.", collect, [])
    .option("--audience <audience>", "Provider audience. Repeatable.", collect, [])
    .option("--validity-buffer-ms <ms>", "Refresh buffer in milliseconds")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: ConnectorTokenOptions) =>
      runAction(async () => {
        const body = {
          subject: parseSubject(opts.subject ?? "app"),
          installation_id: opts.installationId,
          project_id: opts.project,
          environment: opts.project || opts.resourceId ? opts.environment : undefined,
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          ...externalAttribution(opts),
          scopes: opts.scope?.length ? opts.scope : undefined,
          audience: opts.audience?.length ? opts.audience : undefined,
          validity_buffer_ms: opts.validityBufferMs
            ? Number.parseInt(opts.validityBufferMs, 10)
            : undefined,
        };
        const raw = await client().apiPost<unknown>(
          `/api/v1/connect/token/${enc(connector)}`,
          body,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  connectors
    .command("installations")
    .description("List Connect provider installations/grants")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--connector-id <id>", "Filter by Connect connector row ID")
    .option("--status <status>", "Filter by installation status")
    .option("--external-workspace-id <id>", "Filter by white-label workspace attribution")
    .option("--external-user-id <id>", "Filter by white-label user attribution")
    .option("--external-project-id <id>", "Filter by white-label project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorLinkListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/installations${queryString(linkFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No connector installations found."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "CONNECTOR", key: (row) => String(row.connector_id ?? ""), width: 36 },
          { header: "INSTALLATION", key: (row) => String(row.installation_id ?? ""), width: 18 },
          { header: "STATUS", key: (row) => String(row.status ?? ""), width: 12 },
        ]);
      }),
    );

  const oauth = connectors
    .command("oauth")
    .description("Start provider OAuth authorization flows");

  oauth
    .command("providers")
    .description("List OAuth providers available for end-user authorization")
    .option("--json", "Output as JSON")
    .action((opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>("/api/v1/connect/oauth/providers");
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No OAuth providers configured."));
          return;
        }
        renderTable(rows, [
          { header: "PROVIDER", key: (row) => String(row.provider ?? ""), width: 18 },
          { header: "NAME", key: (row) => String(row.display_name ?? ""), width: 24 },
          { header: "SCOPES", key: (row) => String((row.scopes as unknown[])?.join?.(",") ?? ""), width: 32 },
          { header: "ENABLED", key: (row) => String(row.enabled ?? ""), width: 8 },
        ]);
      }),
    );

  oauth
    .command("start <provider>")
    .description("Start an OAuth authorization flow for a provider-backed connector")
    .option("--scope <scope>", "OAuth provider scope string")
    .option("--expose-as-env", "Create an env binding after authorization")
    .option("--owner-user-id <id>", "Internal user id that owns this connection")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--json", "Output as JSON")
    .action((provider: string, opts: ConnectorOauthStartOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          "/api/v1/connect/oauth/start",
          compactBody({
            provider,
            scope: opts.scope,
            expose_as_env: opts.exposeAsEnv,
            owner_user_id: opts.ownerUserId,
            ...externalAttribution(opts),
          }),
        );
        const data = unwrapData(raw);
        if (isJson(opts)) {
          printJson(data);
          return;
        }
        const authorizeUrl =
          data && typeof data === "object"
            ? String((data as Record<string, unknown>).authorize_url ?? "")
            : "";
        if (!authorizeUrl) {
          printJson(data);
          return;
        }
        console.log(authorizeUrl);
      }),
    );

  const projectLinks = connectors
    .command("project-links")
    .alias("links")
    .description("Manage project/environment connector links");

  projectLinks
    .command("list")
    .description("List project connector links")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--connector-id <id>", "Filter by Connect connector row ID")
    .option("--environment <name>", "Filter by environment")
    .option("--external-workspace-id <id>", "Filter by white-label workspace attribution")
    .option("--external-user-id <id>", "Filter by white-label user attribution")
    .option("--external-project-id <id>", "Filter by white-label project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorLinkListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/project-links${queryString(linkFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No project connector links found."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "CONNECTOR", key: (row) => String(row.connector_id ?? ""), width: 36 },
          { header: "PROJECT", key: (row) => String(row.project_id ?? ""), width: 20 },
          { header: "ENV", key: (row) => String(row.environment ?? ""), width: 12 },
          { header: "MODE", key: (row) => String(row.mode ?? ""), width: 14 },
        ]);
      }),
    );

  projectLinks
    .command("create <connector>")
    .description("Link a connector to a project/environment/resource")
    .option("--connector-id <id>", "Connect connector row ID instead of UID")
    .option("--installation-id <id>", "Connector installation row ID")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name", "development")
    .option("--resource-type <type>", "Optional resource type: sandbox, computer, deployment")
    .option("--resource-id <id>", "Optional resource ID")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--subject <subject>", "Allowed subject type. Repeatable.", collect, [])
    .option("--scope <scope>", "Allowed provider scope. Repeatable.", collect, [])
    .option("--mode <mode>", "token-api, brokered-env, or plain-env", "brokered-env")
    .option("--effect <effect>", "allow or deny", "allow")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: ConnectorProjectLinkCreateOptions) =>
      runAction(async () => {
        const body = {
          connector: opts.connectorId ? undefined : connector,
          connector_id: opts.connectorId,
          installation_id: opts.installationId,
          workspace_id: opts.workspace,
          project_id: opts.project,
          environment: opts.environment,
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          ...externalAttribution(opts),
          allowed_subjects: opts.subject?.length ? opts.subject : undefined,
          allowed_scopes: opts.scope?.length ? opts.scope : undefined,
          mode: opts.mode ? normalizeMode(opts.mode) : undefined,
          effect: opts.effect,
        };
        const raw = await client().apiPost<unknown>(
          "/api/v1/connect/project-links",
          compactBody(body),
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  projectLinks
    .command("delete <link-id>")
    .alias("rm")
    .description("Delete a project connector link")
    .option("--json", "Output as JSON")
    .action((linkId: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiDelete<unknown>(
          `/api/v1/connect/project-links/${enc(linkId)}`,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  const triggers = connectors
    .command("triggers")
    .description("Manage inbound connector trigger forwarding definitions");

  triggers
    .command("list")
    .description("List inbound connector triggers")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--connector-id <id>", "Filter by Connect connector row ID")
    .option("--environment <name>", "Filter by environment")
    .option("--status <status>", "Filter by status")
    .option("--external-workspace-id <id>", "Filter by white-label workspace attribution")
    .option("--external-user-id <id>", "Filter by white-label user attribution")
    .option("--external-project-id <id>", "Filter by white-label project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorLinkListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/triggers${queryString(linkFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No connector triggers found."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "CONNECTOR", key: (row) => String(row.connector_id ?? ""), width: 36 },
          { header: "ENV", key: (row) => String(row.environment ?? ""), width: 12 },
          { header: "DEST", key: (row) => String(row.destination_path ?? row.destination_url ?? ""), width: 32 },
        ]);
      }),
    );

  triggers
    .command("create <connector>")
    .description("Create an inbound connector trigger")
    .option("--connector-id <id>", "Connect connector row ID instead of UID")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name", "production")
    .option("--destination-path <path>", "Internal app path that receives forwarded events")
    .option("--destination-url <url>", "External URL that receives forwarded events")
    .option("--event-type <type>", "Provider event type. Repeatable.", collect, [])
    .option("--status <status>", "active, disabled, or error", "active")
    .option("--provider-adapter <adapter>", "Provider webhook adapter: generic, github, or slack")
    .option("--webhook-signing-secret <secret>", "Provider signing secret. If omitted for GitHub/Slack, MIOSA generates one and returns it once.")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: ConnectorTriggerCreateOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          "/api/v1/connect/triggers",
          compactBody({
            connector: opts.connectorId ? undefined : connector,
            connector_id: opts.connectorId,
            workspace_id: opts.workspace,
            project_id: opts.project,
            environment: opts.environment,
            destination_path: opts.destinationPath,
            destination_url: opts.destinationUrl,
            event_types: opts.eventType?.length ? opts.eventType : undefined,
            status: opts.status,
            provider_adapter: opts.providerAdapter,
            webhook_signing_secret: opts.webhookSigningSecret,
            ...externalAttribution(opts),
          }),
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  triggers
    .command("delete <trigger-id>")
    .alias("rm")
    .description("Delete an inbound connector trigger")
    .option("--json", "Output as JSON")
    .action((triggerId: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiDelete<unknown>(
          `/api/v1/connect/triggers/${enc(triggerId)}`,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  triggers
    .command("deliveries")
    .description("List inbound connector trigger delivery attempts")
    .option("--trigger <id>", "Filter by trigger ID")
    .option("--connector-id <id>", "Filter by Connect connector row ID")
    .option("--state <state>", "Filter by delivery state")
    .option("--event-type <type>", "Filter by event type")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorTriggerDeliveryOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/trigger-deliveries${queryString(triggerDeliveryFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No connector trigger deliveries found."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "TRIGGER", key: (row) => String(row.trigger_id ?? ""), width: 36 },
          { header: "EVENT", key: (row) => String(row.event_type ?? ""), width: 18 },
          { header: "STATE", key: (row) => String(row.state ?? ""), width: 12 },
          { header: "STATUS", key: (row) => String(row.status_code ?? ""), width: 8 },
        ]);
      }),
    );

  const defaults = connectors
    .command("defaults")
    .description("Manage inherited connector defaults for future runtimes");

  defaults
    .command("list")
    .description("List inherited connector defaults")
    .option("--workspace <id>", "Filter by workspace ID")
    .option("--project <id>", "Filter by project ID")
    .option("--connector-id <id>", "Filter by Connect connector row ID")
    .option("--environment <name>", "Filter by environment")
    .option(
      "--default-scope <scope>",
      "tenant, workspace, project, environment, external-workspace, external-project, or external-user",
    )
    .option("--target <target>", "all, sandbox, computer, agent, or deployment")
    .option("--external-workspace-id <id>", "Filter by white-label workspace attribution")
    .option("--external-user-id <id>", "Filter by white-label user attribution")
    .option("--external-project-id <id>", "Filter by white-label project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorDefaultListOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/defaults${queryString(defaultFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No connector defaults found."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "CONNECTOR", key: (row) => String(row.connector_id ?? ""), width: 36 },
          { header: "SCOPE", key: (row) => String(row.default_scope ?? ""), width: 12 },
          { header: "TARGET", key: (row) => String(row.target ?? ""), width: 12 },
          { header: "PROJECT", key: (row) => String(row.project_id ?? ""), width: 20 },
        ]);
      }),
    );

  defaults
    .command("applicable")
    .description("Resolve inherited connector defaults for a runtime target")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name", "development")
    .option("--target <target>", "all, sandbox, computer, agent, or deployment", "agent")
    .option("--resource-type <type>", "Optional resource type: sandbox, computer, deployment")
    .option("--resource-id <id>", "Optional resource ID")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorApplicableDefaultOptions) =>
      runAction(async () => {
        const raw = await client().apiGet<unknown>(
          `/api/v1/connect/defaults/applicable${queryString(applicableDefaultFilters(opts))}`,
        );
        const rows = unwrapList<Record<string, unknown>>(raw);
        if (isJson(opts)) {
          printJson(rows);
          return;
        }
        if (rows.length === 0) {
          console.log(chalk.dim("No inherited connector defaults apply."));
          return;
        }
        renderTable(rows, [
          { header: "ID", key: (row) => String(row.id ?? ""), width: 36 },
          { header: "CONNECTOR", key: (row) => String(row.connector_id ?? ""), width: 36 },
          { header: "SCOPE", key: (row) => String(row.default_scope ?? ""), width: 12 },
          { header: "TARGET", key: (row) => String(row.target ?? ""), width: 12 },
          {
            header: "MATCH",
            key: (row) =>
              String(
                ((row.applicability as Record<string, unknown> | undefined) ?? {})
                  .matched_scope ?? "",
              ),
            width: 12,
          },
        ]);
      }),
    );

  defaults
    .command("materialize")
    .description("Materialize inherited connector defaults onto a runtime resource")
    .requiredOption("--resource-type <type>", "Runtime resource type: sandbox, computer, deployment")
    .requiredOption("--resource-id <id>", "Runtime resource ID")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name", "development")
    .option("--target <target>", "all, sandbox, computer, agent, or deployment", "agent")
    .option("--env <name>", "Override the default env var name")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--json", "Output as JSON")
    .action((opts: ConnectorMaterializeDefaultOptions) =>
      runAction(async () => {
        const raw = await client().apiPost<unknown>(
          "/api/v1/connect/defaults/materialize",
          materializeDefaultBody(opts),
        );
        const data = unwrapData(raw);
        if (isJson(opts)) {
          printJson(data);
          return;
        }
        const result = data as { applied?: unknown; results?: Array<Record<string, unknown>> };
        console.log(chalk.green(`Applied ${String(result.applied ?? 0)} connector defaults.`));
        const rows = Array.isArray(result.results) ? result.results : [];
        if (rows.length > 0) {
          renderTable(rows, [
            { header: "STATUS", key: (row) => String(row.status ?? ""), width: 10 },
            { header: "DEFAULT", key: (row) => String(row.default_id ?? ""), width: 36 },
            { header: "REASON", key: (row) => String(row.reason ?? ""), width: 24 },
          ]);
        }
      }),
    );

  defaults
    .command("create <connector>")
    .description("Create an inherited connector default")
    .option("--connector-id <id>", "Connect connector row ID instead of UID")
    .option("--installation-id <id>", "Connector installation row ID")
    .option("--workspace <id>", "Workspace ID")
    .option("--project <id>", "Project ID")
    .option("--environment <name>", "Environment name", "development")
    .option(
      "--default-scope <scope>",
      "tenant, workspace, project, environment, external-workspace, external-project, or external-user",
    )
    .option("--target <target>", "all, sandbox, computer, agent, or deployment", "all")
    .option("--subject <subject>", "Allowed subject type. Repeatable.", collect, [])
    .option("--scope <scope>", "Allowed provider scope. Repeatable.", collect, [])
    .option("--mode <mode>", "token-api, brokered-env, or plain-env", "brokered-env")
    .option("--effect <effect>", "allow or deny", "allow")
    .option("--external-workspace-id <id>", "White-label platform workspace attribution")
    .option("--external-user-id <id>", "White-label platform user attribution")
    .option("--external-project-id <id>", "White-label platform project attribution")
    .option("--json", "Output as JSON")
    .action((connector: string, opts: ConnectorDefaultCreateOptions) =>
      runAction(async () => {
        const body = {
          connector: opts.connectorId ? undefined : connector,
          connector_id: opts.connectorId,
          installation_id: opts.installationId,
          workspace_id: opts.workspace,
          project_id: opts.project,
          environment: opts.environment,
          default_scope: opts.defaultScope,
          target: opts.target,
          ...externalAttribution(opts),
          allowed_subjects: opts.subject?.length ? opts.subject : undefined,
          allowed_scopes: opts.scope?.length ? opts.scope : undefined,
          mode: opts.mode ? normalizeMode(opts.mode) : undefined,
          effect: opts.effect,
        };
        const raw = await client().apiPost<unknown>(
          "/api/v1/connect/defaults",
          compactBody(body),
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );

  defaults
    .command("delete <default-id>")
    .alias("rm")
    .description("Delete an inherited connector default")
    .option("--json", "Output as JSON")
    .action((defaultId: string, opts: JsonOptions) =>
      runAction(async () => {
        const raw = await client().apiDelete<unknown>(
          `/api/v1/connect/defaults/${enc(defaultId)}`,
        );
        printMaybeJson(unwrapData(raw), opts);
      }),
    );
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseSubject(value: string): Record<string, string> {
  if (value === "app") return { type: "app" };
  if (value.startsWith("user:")) return { type: "user", id: value.slice(5) };
  if (value.startsWith("jwt-bearer:")) {
    return { type: "jwt-bearer", sub: value.slice("jwt-bearer:".length) };
  }
  throw new Error("Use --subject app, user:<id>, or jwt-bearer:<sub>");
}

async function readCredentialValue(opts: ConnectorCreateOptions): Promise<string> {
  const sources = [opts.value, opts.stdin ? "stdin" : undefined, opts.file].filter(
    Boolean,
  );
  if (sources.length !== 1) {
    throw new Error("Provide exactly one of --value, --stdin, or --file");
  }
  const raw =
    opts.value ??
    (opts.file ? fs.readFileSync(opts.file, "utf8") : await readStdin());
  const value = raw.trim();
  if (!value) throw new Error("Credential value cannot be empty");
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeMode(value: string): string {
  return value.replaceAll("-", "_");
}

function linkFilters(opts: ConnectorLinkListOptions): Record<string, string> {
  return compactQuery({
    workspace_id: opts.workspace,
    project_id: opts.project,
    connector_id: opts.connectorId,
    environment: opts.environment,
    status: opts.status,
    ...externalAttribution(opts),
  });
}

function defaultFilters(opts: ConnectorDefaultListOptions): Record<string, string> {
  return {
    ...linkFilters(opts),
    ...compactQuery({
      default_scope: opts.defaultScope,
      target: opts.target,
    }),
  };
}

function applicableDefaultFilters(
  opts: ConnectorApplicableDefaultOptions,
): Record<string, string> {
  return compactQuery({
    workspace_id: opts.workspace,
    project_id: opts.project,
    environment: opts.environment,
    target: opts.target,
    resource_type: opts.resourceType,
    resource_id: opts.resourceId,
    ...externalAttribution(opts),
  });
}

function materializeDefaultBody(
  opts: ConnectorMaterializeDefaultOptions,
): Record<string, unknown> {
  return compactBody({
    workspace_id: opts.workspace,
    project_id: opts.project,
    environment: opts.environment,
    target: opts.target,
    resource_type: opts.resourceType,
    resource_id: opts.resourceId,
    env_name: opts.env,
    ...externalAttribution(opts),
  });
}

function triggerDeliveryFilters(opts: ConnectorTriggerDeliveryOptions): Record<string, string> {
  return compactQuery({
    connector_id: opts.connectorId,
    trigger_id: opts.trigger,
    state: opts.state,
    event_type: opts.eventType,
  });
}

function externalAttribution(opts: {
  externalWorkspaceId?: string;
  externalUserId?: string;
  externalProjectId?: string;
}): Record<string, string | undefined> {
  return {
    external_workspace_id: opts.externalWorkspaceId,
    external_user_id: opts.externalUserId,
    external_project_id: opts.externalProjectId,
  };
}

function compactQuery<T extends Record<string, unknown>>(value: T): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined && entry !== "")
      .map(([key, entry]) => [key, String(entry)]),
  );
}

function compactBody<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""),
  );
}

function queryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value);
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries as Array<[string, string]>).toString()}`;
}

function unwrapData(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in raw) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

function unwrapList<T>(raw: unknown): T[] {
  const data = unwrapData(raw);
  return Array.isArray(data) ? (data as T[]) : [];
}

function printMaybeJson(value: unknown, opts: JsonOptions): void {
  if (isJson(opts)) {
    printJson(value);
    return;
  }
  if (Array.isArray(value)) {
    printJson(value);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      console.log(`${chalk.bold(key.padEnd(18))} ${formatValue(entry)}`);
    }
    return;
  }
  console.log(String(value ?? ""));
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return chalk.dim("-");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isJson(opts: JsonOptions): boolean {
  return opts.json === true;
}
