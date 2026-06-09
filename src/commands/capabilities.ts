import type { Command } from "commander";
import chalk from "chalk";
import { printJson } from "./util.js";

type CapabilityStatus = "stable" | "beta" | "partial" | "probe_required";

interface CommandRecipe {
  command: string;
  purpose: string;
  json: boolean;
  wait?: boolean;
  notes?: string[];
}

interface Workflow {
  id: string;
  title: string;
  goal: string;
  status: CapabilityStatus;
  steps: CommandRecipe[];
  success_signals: string[];
  failure_signals: string[];
}

interface ResourceCapability {
  id: string;
  label: string;
  purpose: string;
  status: CapabilityStatus;
  list?: string;
  create?: string;
  show?: string;
  delete?: string;
  notes?: string[];
}

interface CapabilitiesManifest {
  schema_version: "2026-06-01";
  cli: {
    name: "miosa";
    agent_entrypoint: string;
    default_machine_mode: string;
    global_flags: string[];
    global_env: string[];
  };
  contract: {
    json_output: string;
    resource_inputs: string;
    errors: {
      shape: {
        ok: false;
        error: {
          code: string;
          message: string;
          retryable: boolean;
          request_id?: string;
          hint?: string;
          details?: unknown;
        };
      };
      guidance: string[];
    };
    destructive_actions: string[];
    auth: string[];
  };
  resources: ResourceCapability[];
  workflows: Workflow[];
  probing: {
    docker_in_sandbox: CommandRecipe[];
    live_smoke: CommandRecipe[];
  };
}

const manifest: CapabilitiesManifest = {
  schema_version: "2026-06-01",
  cli: {
    name: "miosa",
    agent_entrypoint: "miosa capabilities --json",
    default_machine_mode:
      "Set MIOSA_JSON=1 MIOSA_NO_COLOR=1 and pass --json to every command that supports it.",
    global_flags: [
      "--json",
      "--debug",
      "--quiet",
      "--no-color",
      "--tenant <tenant>",
      "--workspace <workspace>",
    ],
    global_env: [
      "MIOSA_JSON=1",
      "MIOSA_DEBUG=1",
      "MIOSA_QUIET=1",
      "MIOSA_NO_COLOR=1",
      "MIOSA_TENANT=<tenant>",
      "MIOSA_WORKSPACE=<workspace-id>",
      "MIOSA_API_KEY=<msk_...>",
      "MIOSA_ENDPOINT=<url>",
    ],
  },
  contract: {
    json_output:
      "Prefer --json or MIOSA_JSON=1. Human spinners and tables are suppressed in agent-facing paths that support JSON.",
    resource_inputs:
      "Resource create/update commands that use the generic request-body path accept --data '<json>', --input '<json-or-yaml>', or --file ./resource.yml.",
    errors: {
      shape: {
        ok: false,
        error: {
          code: "STRING_CODE",
          message: "Actionable human-readable message.",
          retryable: false,
          request_id: "req_optional",
          hint: "optional recovery hint",
          details: {},
        },
      },
      guidance: [
        "If code is AUTH or message mentions revoked/expired/invalid, run miosa login or install a fresh API key.",
        "If retryable is true, back off and retry after the hinted interval if present.",
        "If --debug is set, preserve request_id and details in issue reports.",
      ],
    },
    destructive_actions: [
      "Use --dry-run before bulk cleanup.",
      "Use --force or --yes only after the dry-run resource IDs match intent.",
      "Deletes should be treated as idempotent, but agents should still record IDs before deleting.",
    ],
    auth: [
      "miosa whoami verifies live by default.",
      "miosa whoami --cached is explicitly stale and should not be used as proof that API calls will work.",
      "miosa doctor --json is the preferred auth/API reachability diagnostic.",
    ],
  },
  resources: [
    {
      id: "cli_context",
      label: "CLI Context",
      purpose:
        "Named account/tenant/workspace defaults for switching between personal, team, and customer scopes.",
      status: "stable",
      list: "miosa context ls --json",
      create: "miosa context save <name> --json",
      show: "miosa context show <name> --json",
      delete: "miosa context rm <name> --json",
      notes: [
        "Use miosa context use <name> --json to switch active API key, endpoint, tenant, workspace, region, and default host.",
        "Use miosa context set workspace <workspace-id> --json to pin the default workspace for later commands.",
        "Global --tenant and --workspace flags still override the saved context for one command.",
      ],
    },
    {
      id: "sandbox",
      label: "Sandbox Preview",
      purpose:
        "Temporary agent/user workspace for build, test, preview, and publish.",
      status: "stable",
      list: "miosa sandbox list --json",
      create: "miosa sandbox create --wait --json",
      show: "miosa sandbox show <sandbox-id> --json",
      delete: "miosa sandbox delete <sandbox-id> --force --json",
      notes: [
        "For app templates, prefer --template <id> --auto-start --publish-port <port> --wait --json.",
        "Next.js starter template: miosa sandbox create --template nextjs --auto-start --publish-port 3000 --wait --json.",
        "Use sandbox deploy for preview readiness.",
        "Use sandbox publish to promote to durable app hosting.",
        "Use sandbox publish --docker-deploy to promote a sandbox-built app through the workspace Docker Deploy runtime.",
        "Use sandbox env and sandbox db attach for durable encrypted runtime env; do not hand-write .env files.",
        "Use miosa sandbox ports <sandbox-id> --json before previewing to detect port conflicts.",
        "Use miosa sandbox metrics <sandbox-id> --json for readiness, timeout, and resource diagnostics.",
      ],
    },
    {
      id: "computer",
      label: "Computer",
      purpose:
        "Durable desktop/VM surface for SSH, exec, files, services, tunnels, and agent sessions.",
      status: "stable",
      list: "miosa computers list --json",
      create: "miosa up --computer --json",
      show: "miosa computers show <computer-id> --json",
      delete: "miosa computers delete <computer-id> --force --json",
      notes: [
        "Use miosa ssh/exec/cp/tunnel for operator-style control.",
        "Use miosa agent for persistent Computer agent session lifecycle.",
      ],
    },
    {
      id: "deployment_app",
      label: "Deployment App",
      purpose:
        "Durable hosted app with default URL, releases, env vars, logs, rollback, and domains.",
      status: "beta",
      list: "miosa apps list --json",
      create: "miosa deploy --json",
      show: "miosa apps show <app-id-or-slug> --json",
      delete: "miosa apps destroy <app-id-or-slug> --force --json",
      notes: [
        "Default URL should work independently of custom-domain DNS state.",
        "Use miosa deploy metrics <app-id> --json to inspect runtime instances, health timestamps, restarts, and usage.",
      ],
    },
    {
      id: "database",
      label: "Managed Database",
      purpose:
        "Managed Postgres lifecycle, connection strings, logs, backup/restore, and attachment.",
      status: "beta",
      list: "miosa databases list --json",
      create:
        "miosa databases create --name <name> --engine postgres --workspace <workspace-id> --wait --json",
      show: "miosa databases get <db-id> --json",
      delete: "miosa databases delete <db-id> --force --json",
      notes: [
        "Use miosa databases wait <db-id> --ready --timeout 120 --json before attaching.",
        "Use start/stop/restart for explicit lifecycle recovery.",
        "Agents should smoke-test recommended/proxy connect URLs before marking app/database flows ready.",
        "Use miosa databases metrics <db-id> --json for resource and uptime diagnostics.",
      ],
    },
    {
      id: "workspace",
      label: "Workspace",
      purpose:
        "Tenant-scoped resource boundary for ClinicIQ/admin cleanup and inventory.",
      status: "stable",
      list: "miosa workspaces list --json",
      create: "miosa workspaces create --name <name> --json",
      show: "miosa workspaces show <workspace-id> --json",
      delete: "miosa workspaces delete <workspace-id> --force --json",
      notes: [
        "Use --workspace globally to scope supported list/create/delete calls.",
      ],
    },
    {
      id: "custom_domain",
      label: "Custom Domain",
      purpose:
        "CNAME/custom hostname verification and assignment for apps or Computers.",
      status: "beta",
      list: "miosa domains list <computer-id> --json",
      create: "miosa domains add app.example.com --app <app-id> --json",
      show: "miosa domains status app.example.com --json",
      delete: "miosa domains delete app.example.com --json",
      notes: ["Real DNS is required for end-to-end verify tests."],
    },
    {
      id: "template",
      label: "Dockerfile Sandbox Template",
      purpose: "E2B-style custom sandbox environment built from a Dockerfile.",
      status: "beta",
      list: "miosa templates list --json",
      create:
        "miosa templates create --name <name> --dockerfile ./Dockerfile --json",
      show: "miosa templates get <template-id> --json",
      delete: "miosa templates delete <template-id> --force --json",
      notes: [
        "This is the official custom environment path. Docker-in-sandbox is not assumed.",
      ],
    },
  ],
  workflows: [
    {
      id: "context_scoped_workflow",
      title: "Switch Account Or Workspace Context",
      goal: "Make repeated CLI and agent runs target the correct tenant/workspace without passing scope flags every time.",
      status: "stable",
      steps: [
        {
          command: "miosa context ls --json",
          purpose: "Inspect saved contexts and the active context.",
          json: true,
        },
        {
          command: "miosa context use <name> --json",
          purpose: "Switch active endpoint, API key, tenant, workspace, region, and default host.",
          json: true,
        },
        {
          command: "miosa context set workspace <workspace-id> --json",
          purpose: "Pin a default workspace on the active context.",
          json: true,
        },
        {
          command: "miosa command-overview --json",
          purpose: "Discover available command groups and nested subcommands.",
          json: true,
        },
      ],
      success_signals: [
        "context ls returns active context",
        "context use returns ok true",
        "whoami --json still verifies live",
      ],
      failure_signals: [
        "Context not found",
        "AUTH error after switching",
        "workspace-scoped commands return unauthorized or not found",
      ],
    },
    {
      id: "auth_health",
      title: "Verify Auth And API Health",
      goal: "Prove the CLI can make live API calls before running expensive workflows.",
      status: "stable",
      steps: [
        {
          command: "miosa whoami --json",
          purpose: "Live identity check; does not trust stale cache.",
          json: true,
        },
        {
          command: "miosa doctor --json",
          purpose:
            "Diagnose config, API reachability, auth, and local toolchain.",
          json: true,
        },
      ],
      success_signals: ["authenticated true", "doctor Authentication check ok"],
      failure_signals: [
        "AUTH error",
        "API key has been revoked",
        "API unreachable",
      ],
    },
    {
      id: "dockerfile_template_sandbox",
      title: "Create Sandbox From Dockerfile Template",
      goal: "Build a custom environment and boot a sandbox from it.",
      status: "beta",
      steps: [
        {
          command:
            "miosa templates create --name <name> --dockerfile ./Dockerfile --json",
          purpose: "Create template and trigger build.",
          json: true,
        },
        {
          command: "miosa templates builds <template-id> --json",
          purpose: "Inspect template build status/log metadata.",
          json: true,
        },
        {
          command:
            "miosa sandbox create --template <template-id> --wait --json",
          purpose: "Boot a sandbox using the custom template.",
          json: true,
          wait: true,
        },
        {
          command:
            'miosa sandbox exec <sandbox-id> --json -- "which node || which python || env"',
          purpose: "Verify expected tools exist inside the template.",
          json: true,
        },
      ],
      success_signals: [
        "template state ready/active",
        "sandbox state running",
        "exec exit_code 0",
      ],
      failure_signals: [
        "template build failed",
        "sandbox create timeout",
        "missing expected tools",
      ],
    },
    {
      id: "nextjs_template_preview",
      title: "Create Working Next.js Preview From Template",
      goal: "Give an agent a ready-to-edit Next.js app with a public preview URL, without manually scaffolding package.json or app files.",
      status: "stable",
      steps: [
        {
          command:
            "miosa sandbox create --template nextjs --auto-start --publish-port 3000 --wait --timeout 900 --json",
          purpose:
            "Create a Next.js sandbox, seed starter files into /workspace, install dependencies, start dev server, expose port 3000, and wait for public HTTP 200.",
          json: true,
          wait: true,
          notes: [
            "Expected JSON includes id, state=running, ready=true, template_id=nextjs, preview.url, preview.status=200.",
            "The backend seeds /workspace/package.json and /workspace/app/page.jsx only when /workspace is empty.",
          ],
        },
        {
          command:
            "miosa sandbox exec <sandbox-id> --cwd /workspace --json -- bash -lc \"ls package.json app/page.jsx && npm run build\"",
          purpose:
            "Verify the scaffold exists and the app builds before publishing.",
          json: true,
        },
        {
          command:
            "miosa sandbox publish <sandbox-id> --path /workspace --slug <slug> --build-command \"npm run build\" --run-command \"npm run start\" --port 3000 --wait --timeout 900 --json",
          purpose:
            "Promote the working Next.js sandbox into durable app hosting.",
          json: true,
          wait: true,
        },
        {
          command:
            "miosa sandbox publish <sandbox-id> --path /workspace --slug <slug> --build-command \"npm run build\" --run-command \"npm run start\" --port 3000 --docker-deploy --wait --timeout 900 --json",
          purpose:
            "Promote the same sandbox-built app through the workspace Docker Deploy runtime.",
          json: true,
          wait: true,
        },
      ],
      success_signals: [
        "sandbox state running",
        "ready true",
        "preview.status 200",
        "preview.url returns Next.js HTML",
        "scaffold status ready in sandbox metadata",
        "docker deploy response includes deployment_product docker_deploy when --docker-deploy is used",
      ],
      failure_signals: [
        "workspace missing package.json",
        "template_lifecycle.status error",
        "npm install timeout",
        "preview.status not 200",
      ],
    },
    {
      id: "sandbox_preview",
      title: "Build And Preview In Sandbox",
      goal: "Upload local app, start service, wait for external preview readiness.",
      status: "stable",
      steps: [
        {
          command:
            'miosa sandbox deploy ./app --port 5173 --start "npm run dev -- -H 0.0.0.0 -p 5173" --wait --json',
          purpose: "Atomic upload/start/expose/wait preview flow.",
          json: true,
          wait: true,
        },
        {
          command: "miosa sandbox doctor <sandbox-id> --port 5173 --json",
          purpose: "Diagnose process, route, TLS, proxy, and public probe.",
          json: true,
        },
      ],
      success_signals: ["preview_ready true", "preview_url returns public 200"],
      failure_signals: [
        "preview_ready false",
        "TLS pending",
        "edge probe failed",
      ],
    },
    {
      id: "managed_postgres_ready",
      title: "Create Managed Postgres And Wait For Proxy Readiness",
      goal: "Provision a workspace-scoped database and only continue after the reachable endpoint accepts TCP.",
      status: "beta",
      steps: [
        {
          command:
            "miosa databases create --name <name> --engine postgres --workspace <workspace-id> --wait --timeout 120 --json",
          purpose:
            "Create Postgres in the intended workspace and wait for running plus connection_test ok.",
          json: true,
          wait: true,
        },
        {
          command:
            "miosa databases wait <db-id> --ready --timeout 120 --json",
          purpose:
            "Re-check readiness before attaching to a sandbox or deployment.",
          json: true,
          wait: true,
        },
        {
          command: "miosa databases connect <db-id> --print-url",
          purpose: "Fetch the recommended connection URL for smoke tests.",
          json: false,
        },
        {
          command: "miosa databases logs <db-id> --lines 100 --json",
          purpose: "Read recent DB logs without relying on SSE.",
          json: true,
        },
        {
          command:
            "miosa sandbox db attach <sandbox-id> <db-id> --json",
          purpose:
            "Persist DATABASE_URL and PG* vars in encrypted sandbox env and sync them into the live VM.",
          json: true,
        },
        {
          command: "miosa sandbox env sync <sandbox-id> --json",
          purpose:
            "Re-sync encrypted sandbox env vars after a restart/rebuild when needed.",
          json: true,
        },
      ],
      success_signals: [
        "state running",
        "connection_test.status ok",
        "sandbox db attach attached true",
        "proxy_status ready or not_configured for single-host dev",
      ],
      failure_signals: [
        "DATABASE_PROVISION_FAILED",
        "DATABASE_CONNECTIVITY_FAILED",
        "state error",
      ],
    },
    {
      id: "publish_durable_app",
      title: "Publish Sandbox To Durable App",
      goal: "Promote sandbox workspace into a durable deployment app with releases.",
      status: "beta",
      steps: [
        {
          command:
            "miosa sandbox publish <sandbox-id> --path /workspace --slug <slug> --wait --json",
          purpose: "Create or update durable app release from sandbox files.",
          json: true,
          wait: true,
        },
        {
          command: "miosa releases list <app-id-or-slug> --json",
          purpose: "Verify release appears in release history.",
          json: true,
        },
        {
          command: "miosa apps open <app-id-or-slug>",
          purpose: "Open default durable app URL for manual check.",
          json: false,
        },
      ],
      success_signals: ["ready true", "default URL 200", "release listed"],
      failure_signals: [
        "BUILD_FAILED",
        "HEALTH_CHECK_FAILED",
        "release missing",
      ],
    },
    {
      id: "computer_agent_control",
      title: "Computer Agent Control",
      goal: "Run persistent AI-agent sessions against a Computer without scraping UI state.",
      status: "partial",
      steps: [
        {
          command: 'miosa agent <computer> "run the tests" --json',
          purpose: "Create persistent agent session.",
          json: true,
        },
        {
          command: "miosa agent get <session-id> --computer <computer> --json",
          purpose: "Fetch session status.",
          json: true,
        },
        {
          command:
            'miosa agent task <session-id> "fix the failure" --computer <computer> --json',
          purpose: "Append task to session history.",
          json: true,
        },
        {
          command:
            "miosa agent history <session-id> --computer <computer> --json",
          purpose: "Read persisted session event/history stream.",
          json: true,
        },
      ],
      success_signals: ["session id returned", "history contains tasks"],
      failure_signals: [
        "agent runtime not executing",
        "session not found",
        "AUTH error",
      ],
    },
    {
      id: "operational_debugging",
      title: "Inspect Logs And Exec Safely",
      goal: "Give agents parser-safe command execution and filtered logs for app/debug loops.",
      status: "stable",
      steps: [
        {
          command:
            'miosa sandbox exec <sandbox-id> --cwd /workspace --cmd "npm run build" --json',
          purpose:
            "Run a command string without requiring -- separator or argv reconstruction.",
          json: true,
        },
        {
          command:
            'miosa sandbox exec <sandbox-id> --cwd /workspace --cmd "npm install && npm run build" --shell-cmd "bash -lc" --json',
          purpose:
            "Run shell expressions, pipes, redirects, and chained commands explicitly.",
          json: true,
        },
        {
          command:
            'miosa logs --deployment <app-id> --lines 200 --contains error --json',
          purpose:
            "Fetch recent deployment logs filtered for a specific text signal.",
          json: true,
        },
        {
          command:
            'miosa logs --sandbox <sandbox-id> --regex "500|panic|failed" --json',
          purpose: "Filter sandbox logs by regex for automated diagnostics.",
          json: true,
        },
        {
          command: "miosa sandbox ports <sandbox-id> --json",
          purpose:
            "List backend-detected listening ports before exposing or diagnosing preview conflicts.",
          json: true,
        },
        {
          command: "miosa sandbox metrics <sandbox-id> --json",
          purpose:
            "Read sandbox state, readiness, timeout, boot, IP, and resource metrics.",
          json: true,
        },
        {
          command: "miosa deploy metrics <app-id> --json",
          purpose:
            "Read deployment runtime instance health, restarts, usage, and heartbeat data.",
          json: true,
        },
        {
          command: "miosa databases metrics <db-id> --json",
          purpose:
            "Read managed database state, engine, resource size, endpoint, and uptime data.",
          json: true,
        },
      ],
      success_signals: [
        "exec exit_code 0",
        "logs JSON parses",
        "logs.count reflects filtered line count",
        "ports JSON parses and expected app port appears",
        "metrics JSON parses and current.state matches resource state",
      ],
      failure_signals: [
        "unknown option from command flags",
        "empty logs during known failure",
        "regex syntax error",
        "port occupied by platform/service instead of app process",
        "metrics current state disagrees with show/status output",
      ],
    },
    {
      id: "safe_workspace_cleanup",
      title: "Safe Workspace Cleanup",
      goal: "Inventory and remove test resources without deleting unrelated customer resources.",
      status: "stable",
      steps: [
        {
          command: "miosa workspaces inventory <workspace-id> --json",
          purpose: "List resources and dependencies before deleting.",
          json: true,
        },
        {
          command:
            "miosa cleanup sandboxes --workspace <workspace-id> --name-prefix ciq-smoke --older-than 2h --dry-run --json",
          purpose: "Preview exact resource IDs that match cleanup filters.",
          json: true,
        },
        {
          command:
            "miosa cleanup sandboxes --workspace <workspace-id> --name-prefix ciq-smoke --older-than 2h --force --json",
          purpose: "Delete only the dry-run-matched resources.",
          json: true,
        },
      ],
      success_signals: [
        "dry_run true with expected IDs",
        "deleted IDs match dry run",
      ],
      failure_signals: [
        "unscoped cleanup",
        "missing dry_run",
        "dependency conflict",
      ],
    },
  ],
  probing: {
    docker_in_sandbox: [
      {
        command: "miosa sandbox create --wait --json",
        purpose: "Create a disposable sandbox.",
        json: true,
        wait: true,
      },
      {
        command:
          'miosa sandbox exec <sandbox-id> --json -- "docker version || which docker || ps aux | grep dockerd"',
        purpose:
          "Probe whether nested Docker is available. Do not assume support from CLI surface alone.",
        json: true,
      },
      {
        command: "miosa sandbox delete <sandbox-id> --force --json",
        purpose: "Clean up the probe sandbox.",
        json: true,
      },
    ],
    live_smoke: [
      {
        command: "miosa whoami --json",
        purpose: "Fail fast on revoked or stale credentials.",
        json: true,
      },
      {
        command: "miosa sandbox create --wait --json",
        purpose: "Verify sandbox creation and wait semantics.",
        json: true,
        wait: true,
      },
      {
        command:
          "miosa sandbox create --template nextjs --auto-start --publish-port 3000 --wait --timeout 900 --json",
        purpose:
          "Verify app-template scaffold, lifecycle start, preview route, TLS, and public probe.",
        json: true,
        wait: true,
      },
      {
        command: 'miosa sandbox exec <sandbox-id> --json -- "pwd && whoami"',
        purpose: "Verify exec path.",
        json: true,
      },
      {
        command: "miosa sandbox delete <sandbox-id> --force --json",
        purpose: "Verify cleanup path.",
        json: true,
      },
    ],
  },
};

function renderText(): void {
  console.log();
  console.log(chalk.bold("MIOSA Agent Capabilities"));
  console.log(chalk.dim("Machine-readable form: miosa capabilities --json"));
  console.log();

  console.log(chalk.bold("Recommended agent setup"));
  console.log(`  ${manifest.cli.default_machine_mode}`);
  console.log();

  console.log(chalk.bold("Core workflows"));
  for (const workflow of manifest.workflows) {
    console.log(
      `  ${chalk.cyan(workflow.id)}  ${workflow.title} (${workflow.status})`,
    );
  }
  console.log();

  console.log(chalk.bold("Probe before assuming"));
  console.log("  docker_in_sandbox");
  console.log("  live_smoke");
  console.log();
}

export function register(program: Command): void {
  program
    .command("capabilities")
    .alias("capability")
    .description(
      "Print agent-readable CLI capabilities, resources, and workflow recipes",
    )
    .option("--json", "Output machine-readable JSON")
    .action((opts: { json?: boolean }) => {
      if (opts.json || process.env["MIOSA_JSON"] === "1") {
        printJson(manifest);
        return;
      }

      renderText();
    });
}
