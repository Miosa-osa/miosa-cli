# @miosa/cli

The official MIOSA command-line interface. Deploy apps and manage OpenComputers hosts from your shell.

```bash
npm install -g @miosa/cli
```

Keep it current from the CLI:

```bash
miosa update
miosa update --check --json
```

## Contexts and command discovery

Save named contexts when you work across personal accounts, team accounts, or
customer workspaces:

```bash
miosa login
miosa context save personal
miosa context set workspace workspace_123

miosa login --api-key msk_u_team...
miosa context save clinic-dev

miosa context ls
miosa context use clinic-dev
```

Agents and scripts should use JSON:

```bash
miosa context ls --json
miosa context use clinic-dev --json
miosa command-overview --json
```

`miosa command-overview` prints a tree of all command groups and nested
subcommands. Use `miosa capabilities --json` for the higher-level agent workflow
contract.

## AWS BYOC host pools

The `cloud` command manages the public BYOC control-plane contract.
It configures AWS trust, region networking and artifacts, host pool limits, server-run preflight, and provisioning.

```bash
miosa cloud accounts create \
  --name "Production AWS" \
  --external-account-id 123456789012 \
  --default-region us-east-1 \
  --json

miosa cloud accounts attach-role <account-id> \
  --role-arn arn:aws:iam::123456789012:role/MiosaByocRole \
  --default-region us-east-1 \
  --json

miosa cloud regions create \
  --account-id <account-id> \
  --provider-region us-east-1 \
  --name "N. Virginia" \
  --subnet-ref subnet-0abc123 \
  --security-group-refs sg-0def456 \
  --instance-profile-ref MiosaByocHost \
  --artifact-manifest-uri s3://miosa-byoc-artifacts/manifest.json \
  --metadata '{"host_image_id":"ami-0123456789abcdef0"}' \
  --json

miosa cloud pools create \
  --region-id <region-id> \
  --instance-type m7i.4xlarge \
  --max-nodes 4 \
  --max-hourly-cents 250 \
  --json

miosa cloud pools provision <pool-id> --count 1 --json
```

New pools default to `m7i.4xlarge`, the verified production shape.
Use `m7i.2xlarge` for the supported baseline tier.
`miosa cloud preflights run --region-id <id>` resolves the customer role and verifies the region, network, AMI, instance type, quota, and runtime artifact contract on the server.

## Deploy — 60 seconds to first deploy

Point the CLI at any repo and it handles the rest: framework detection, build wiring, GitHub webhook setup, and live log streaming.

For production app hosting, MIOSA recommends App Engine. It runs apps on the
workspace App Engine runtime, which is the preferred path for teams deploying
many apps because it gives better runtime packing and lower resource overhead
than one-off app runtimes.

```
$ cd ~/my-project
$ miosa login
$ miosa deploy --docker-deploy

  Detected: Next.js 15 (confidence 95%)
  Repo:     https://github.com/me/my-project
  Branch:   main

? Deployment name: my-project
? Branch to deploy: main
? Build command: npm run build
? Run command: npm start
? Create deployment? Yes

  Deployment "my-project" created (slug: my-project-x7k2)
  Saved .miosa.json

  ACTION REQUIRED — GitHub Webhook
  The webhook secret below is shown ONCE. Store it now.

  Webhook URL:   https://api.miosa.ai/api/v1/integrations/github/webhook
  Content type:  application/json
  Secret:        a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9
  Events:        push

  Add this at: https://github.com/me/my-project/settings/hooks/new

  Initial build queued

  Build log:
  ────────────────────────────────────────────────────────────
  > npm run build
  > next build
  ✓ Compiled successfully
  ────────────────────────────────────────────────────────────

  Deployed

  URL:    https://my-project-x7k2.me.miosa.app

  Next steps:
    miosa deploy logs                          — tail logs
    miosa deploy domain add example.com        — add custom domain
    miosa deploy env set KEY=VALUE             — set env var
```

On subsequent runs from the same directory, `miosa deploy` reads `.miosa.json` and skips all prompts — just queues a rebuild and streams logs.

```bash
# Trigger a rebuild any time
miosa deploy

# Or explicitly
miosa deploy redeploy
```

For apps built inside a sandbox, promote the sandbox workspace through App Engine:

```bash
miosa sandbox publish <sandbox-id> \
  --path /workspace \
  --slug my-app \
  --build-command "npm run build" \
  --run-command "npm run start" \
  --port 3000 \
  --docker-deploy \
  --wait \
  --timeout 900 \
  --json
```

## Agentic sandbox app templates

Agents should start from app templates instead of empty sandboxes when building common web apps. Sandboxes are persistent by default: timeout/stop preserves the filesystem and moves the session to `paused`; `destroy` is the permanent delete operation.

For a working Next.js starter with a public preview:

```bash
miosa sandbox create \
  --template nextjs \
  --auto-start \
  --publish-port 3000 \
  --wait \
  --timeout 1h \
  --json
```

Expected machine-readable success signals:

```json
{
  "state": "running",
  "ready": true,
  "template_id": "nextjs",
  "preview": {
    "ready": true,
    "status": 200,
    "url": "https://3000-<id>.sandbox.<domain>"
  }
}
```

The backend seeds `/workspace/package.json`, `/workspace/app/page.jsx`, and related starter files only when `/workspace` is empty. Agents should verify before publishing:

```bash
miosa sandbox exec <sandbox-id> \
  --cwd /workspace \
  --json \
  -- bash -lc "ls package.json app/page.jsx && npm run build"
```

Discover the full agent contract with:

```bash
miosa capabilities --json
```

### Device routing for agents

Use `miosa devices catalog --json` before launching an agent workflow. It
explains the four execution surfaces:

- `sandbox_worker`: default for code, builds, tests, previews, artifacts, and
  publish. Agents should write and run code inside `/workspace`.
- `computer`: full VM/desktop for browser automation, form filling, dashboard
  logins, screenshots, and Computer Use Agent sessions.
- `local_device`: developer-owned machine for local discovery and MCP setup.
- `docker_deploy_host`: workspace appliance that runs versioned app containers
  after a sandbox-built app is published.

```bash
miosa devices catalog --json
miosa devices list --json
miosa sandbox prompt <sandbox-id> --provider codex --cwd /workspace --json -- "build and test the requested app"
miosa sandbox prompt <sandbox-id> --provider custom --runtime-command "hermes-agent run" --json -- "run the configured agent"
```

### Persistent sandbox workflow

The normal agent loop happens inside the sandbox filesystem:

```bash
miosa sandbox write-file <sandbox-id> /workspace/app/page.jsx ./page.jsx --json
miosa sandbox exec <sandbox-id> --cwd /workspace --cmd "npm install && npm run build" --shell-cmd "bash -lc" --json
miosa sandbox wait <sandbox-id> --port 3000 --timeout 180 --json
```

Stop without losing work:

```bash
miosa sandbox stop <sandbox-id> --json
miosa sandbox resume <sandbox-id> --json
```

Checkpoint and fork:

```bash
miosa sandbox snapshot <sandbox-id> --comment "before auth refactor" --json
miosa sandbox snapshots list <sandbox-id> --json
miosa sandbox create --snapshot <snapshot-id> --timeout 1h --wait --json
miosa sandbox fork <sandbox-id> --name feature-branch --json
```

### Canonical sandbox development contract

`miosa sandbox dev up` runs a project from the canonical `miosa.app.yml` manifest.
The command validates the manifest and CLI authentication, creates or reuses a persistent sandbox, overlay-syncs source files, installs locked dependencies once per lockfile fingerprint, starts named services, waits for internal and public health, and prints stable preview URLs.

```yaml
schema_version: 1
name: clinic-intake

sandbox:
  name: clinic-intake-dev
  template: node
  workdir: /workspace

sync:
  exclude:
    - coverage

dependencies:
  install: npm ci

services:
  web:
    command: npm run dev -- --host 0.0.0.0
    port: 3000
    health:
      path: /health
      timeout: 120

requirements:
  config:
    - NODE_ENV
  secrets:
    - SESSION_SECRET
  database: true
```

Run the project with human-readable or stable JSON output:

```bash
miosa sandbox dev up
miosa sandbox dev up --dir ./app --json
miosa sandbox dev up --dir ./app --sandbox <sandbox-id> --json
```

The command writes `.miosa/sandbox.json` immediately after sandbox creation so a partial run can resume without creating another sandbox.
A saved sandbox is reused only when its project name matches the manifest, unless `--sandbox` explicitly selects one.
Sync is an overlay and never deletes remote files.
It always excludes `.git`, `.miosa`, `.env`, `.env.*`, `node_modules`, `.venv`, `coverage`, and `dist`, plus entries in `sync.exclude`.
This preserves runtime-owned dependency trees, virtual environments, install markers, service logs, and other files that exist only in the sandbox.

Dependency commands must enforce a lockfile.
Supported built-in validation recognizes `npm ci`, frozen pnpm and Bun installs, immutable or frozen Yarn installs, and hash-locked pip installs.
An install marker under `/workspace/.miosa-runtime` makes retries idempotent for the same lockfile fingerprint.

Service commands are sent as JSON data to the sandbox service endpoint.
The CLI does not interpolate secret values into shell commands.
Declare secret names under `requirements.secrets`; set values through the encrypted sandbox environment commands.

Inspect the complete contract with:

```bash
miosa sandbox doctor --full --json
miosa sandbox doctor <sandbox-id> --full --dir ./app --json
```

When no ID is passed, full doctor reads `.miosa/sandbox.json`.
It checks sandbox API state, the exec channel, project filesystem access, named service state, internal listeners, public preview routing, managed database attachment state, required config and secret names, and snapshot capability.
It never returns config or secret values.
JSON output includes `ok`, `sandbox_id`, `manifest`, `checks`, and `failure_codes`.
Each failed check has a stable code and an actionable `remediation` command.

The development contract depends on these existing backend routes:

- `POST /api/v1/sandboxes` and `GET /api/v1/sandboxes/:id` for persistent sandbox lifecycle and API state.
- `POST /api/v1/sandboxes/:id/files` and `POST /api/v1/sandboxes/:id/exec` for source sync, deterministic install, filesystem checks, and internal health.
- `GET`, `POST`, and restart routes under `/api/v1/sandboxes/:id/services` for idempotent named processes.
- `POST /api/v1/sandboxes/:id/expose` for preview routing.
- `GET /api/v1/sandboxes/:id/env` for name-only config and secret presence checks.
- `GET /api/v1/sandboxes/:id/snapshots` for snapshot capability checks.
- Database attachment fields on `GET /api/v1/sandboxes/:id` for attachment inspection.

The CLI does not add release-candidate prepare or prove commands because the current backend contract has no release-candidate prepare endpoint.
Use `miosa sandbox publish`, `miosa releases promote`, and `miosa deploy prove` for the deployment interfaces that do exist.

Use a disposable sandbox only when you explicitly do not want preserved state:

```bash
miosa sandbox create --template node --non-persistent --timeout 10m --json
```

### Agent-safe exec and logs

Use explicit command flags when a command contains shell flags, pipes, redirects,
or `bash -c` style arguments:

```bash
miosa sandbox exec <sandbox-id> \
  --cwd /workspace \
  --cmd "npm install && npm run build" \
  --shell-cmd "bash -lc" \
  --json
```

Top-level logs can target a resource explicitly and filter recent output:

```bash
miosa logs --deployment <app-id> --lines 200 --contains error --json
miosa logs --sandbox <sandbox-id> --regex "500|panic|failed" --json
```

### Deploy sub-commands

```bash
miosa deploy list                          # All deployments for this tenant
miosa deploy logs [id]                     # Tail live build logs
miosa deploy redeploy [id]                 # Manual rebuild
miosa deploy env set KEY=VALUE [--id id]   # Set env var
miosa deploy env list [id]                 # Show env vars (masked)
miosa deploy domain add example.com [id]   # Add custom domain
miosa deploy destroy [id]                  # Tear down deployment
```

### Supported frameworks (auto-detected)

| Framework | Detection | Build | Run |
|---|---|---|---|
| Next.js | `next` in package.json | `npm run build` | `npm start` |
| SvelteKit | `@sveltejs/kit` in package.json | `npm run build` | `node build` |
| Vite + React | `vite` + `react` in package.json | `npm run build` | `npx serve dist` |
| Phoenix (Elixir) | `mix.exs` with `:phoenix` | `mix release` | `_build/prod/rel/.../bin/... start` |
| Django | `manage.py` + `requirements.txt` | `pip install` + `collectstatic` | `gunicorn` |
| Flask | `requirements.txt` with flask | `pip install` | `gunicorn app:app` |
| Ruby on Rails | `Gemfile` + `config/application.rb` | `bundle install` | `rails server` |
| Go | `go.mod` | `go build -o app .` | `./app` |
| Rust | `Cargo.toml` | `cargo build --release` | `./target/release/<name>` |
| Static HTML | `index.html` (no build system) | — | `npx serve .` |

---

## OpenComputers hosts

```bash
# Authenticate
miosa login

# List your hosts
miosa hosts

# Open an interactive terminal
miosa ssh my-mac

# Run a command
miosa exec my-mac "npm test"

# Upload a file
miosa cp ./build.tar.gz my-mac:/tmp/

# Expose a port publicly
miosa tunnel open my-mac --port 3000
```

## Configuration

Config is stored at `~/.miosa/config.json`:

```json
{
  "endpoint": "https://api.miosa.ai",
  "api_key": "msk_u_...",
  "default_host": null
}
```

Precedence: CLI flags > environment variables > config file > interactive prompt.

**Environment variables:**

| Variable | Description |
|---|---|
| `MIOSA_API_KEY` | API key (overrides config file) |
| `MIOSA_ENDPOINT` | API endpoint (overrides config file) |
| `MIOSA_JSON` | Prefer JSON output for commands that support structured output |
| `MIOSA_NO_COLOR` | Disable ANSI color output |
| `MIOSA_DEBUG` | Set to any value to enable debug output |

## Commands

### `miosa deploy [sub-command]`

Deploy a GitHub repo. See the [Deploy section](#deploy--60-seconds-to-first-deploy) above for the full flow.

```bash
miosa deploy --docker-deploy             # Recommended production deploy
miosa deploy                             # First deploy or redeploy from .miosa.json
miosa deploy list [--json]               # List all deployments
miosa deploy logs [id]                   # Tail live build logs
miosa deploy redeploy [id] [--no-follow] # Manual rebuild
miosa deploy env set KEY=VALUE [--id id] # Set env var
miosa deploy env list [id]               # Show env vars (masked)
miosa deploy domain add <domain> [id]    # Add custom domain
miosa deploy destroy [id] [-f]           # Tear down deployment
```

### `miosa login [--api-key key]`

Authenticate with your MIOSA API key. If no key is provided, you'll be prompted interactively.

```bash
miosa login
miosa login --api-key msk_u_yourkey
echo "msk_u_yourkey" | miosa login   # non-TTY / CI
```

### `miosa logout`

Remove the stored API key.

### `miosa hosts [--json]`

List all registered hosts.

```bash
miosa hosts
miosa hosts --json | jq '.[].name'
```

### `miosa host <name-or-id> [--json]`

Show details for a specific host including live telemetry.

```bash
miosa host my-mac
miosa host abc12345
```

### `miosa connect [name]`

Register a new host interactively. Prints the install command and waits for the host to come online.

```bash
miosa connect
miosa connect my-new-server
```

### `miosa ssh <computer-or-host> [--cmd "..."]`

Open an interactive PTY terminal session on a MIOSA Computer. If no Computer matches, the CLI falls back to an OpenComputers host with the same name or ID.

```bash
miosa ssh my-mac
miosa ssh my-mac --cmd "ls -la"
```

### `miosa exec <host> <cmd> [args...] [--cwd dir] [--env KEY=VAL] [--timeout 30s]`

Run a command non-interactively and stream output. Exits with the remote exit code.

```bash
miosa exec my-mac npm test
miosa exec my-mac ls -- -la /tmp
miosa exec my-mac env --env NODE_ENV=production --env PORT=3000
miosa exec my-mac make build --cwd /home/user/project --timeout 10m
```

### `miosa cp <src> <dst>`

Copy files between local and remote. Use `host:/path` for remote paths.

```bash
# Upload
miosa cp ./local.txt my-mac:/tmp/
miosa cp -r ./dist my-mac:/var/www/

# Download
miosa cp my-mac:/var/log/app.log ./
miosa cp my-mac:/home/user/report.pdf ~/Downloads/
```

### `miosa ls <host>:<path> [-a] [-l]`

List files on a host.

```bash
miosa ls my-mac:/tmp
miosa ls my-mac:/home/user -la
miosa ls my-mac:/ -a
```

### `miosa rm <host>:<path> [-r] [-f]`

Remove a file or directory on a host. Prompts for confirmation unless `-f`.

```bash
miosa rm my-mac:/tmp/old-build.tar.gz
miosa rm -rf my-mac:/tmp/build-artifacts
```

### `miosa tunnel open <host> --port <n> [--name slug] [--watch]`

Expose a port on a host publicly.

```bash
miosa tunnel open my-mac --port 3000
miosa tunnel open my-mac --port 8080 --name my-app --watch
```

### `miosa tunnel list <host>`

List active tunnels on a host.

### `miosa tunnel close <host> <slug>`

Close (revoke) a tunnel.

### `miosa agent <computer> "<task>" [--model] [--max-turns]`

Start a resumable Computer Use Agent session on a Computer.

```bash
miosa agent my-mac "run the test suite and fix any failing tests"
miosa agent my-mac "update all npm dependencies" --max-turns 20
miosa agent my-mac "optimize the database queries" --model nemotron-3-super
miosa agent my-mac --resume <session-id> "continue from the last failure"
miosa agent ls
miosa agent history <session-id> --computer my-mac
```

### `miosa completion <shell>`

Print shell completion for `bash`, `zsh`, or `fish`.

```bash
miosa completion zsh > ~/.zsh/completions/_miosa
miosa completion bash > ~/.local/share/bash-completion/completions/miosa
miosa completion fish > ~/.config/fish/completions/miosa.fish
```

### `miosa watch <host>`

Stream live telemetry and events from a host.

```bash
miosa watch my-mac
```

### `miosa status`

Show current auth, endpoint, tenant info, credits, and host count.

```bash
miosa status
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | User error (bad args, not found, etc.) |
| 2 | Network error |
| 3 | Authentication error |
| 4 | Server error |

## Troubleshooting

**"No API key configured"** — Run `miosa login`.

**"Host not found"** — Check `miosa hosts` for the correct name or ID.

**"Insufficient credits"** — Top up at https://miosa.ai/billing.

**Network errors** — Check your connection. Use `MIOSA_DEBUG=1 miosa <cmd>` for stack traces.

**Custom endpoint** — `MIOSA_ENDPOINT=https://your-instance.ai miosa hosts`

## Links

- Documentation: https://docs.miosa.ai/cli
- Platform: https://miosa.ai
- Support: support@miosa.ai

## License

MIT
