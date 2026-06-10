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

## Deploy — 60 seconds to first deploy

Point the CLI at any repo and it handles the rest: framework detection, build wiring, GitHub webhook setup, and live log streaming.

```
$ cd ~/my-project
$ miosa login
$ miosa deploy

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

  URL:    https://my-project-x7k2.my-workspace.miosa.app

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

## Agentic sandbox app templates

Agents should start from app templates instead of empty sandboxes when building common web apps. For a working Next.js starter with a public preview:

```bash
miosa sandbox create \
  --template nextjs \
  --auto-start \
  --publish-port 3000 \
  --wait \
  --timeout 900 \
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

### App manifest

Agents can commit `miosa.app.yml`, `miosa.app.yaml`, or `miosa.app.json` to make
publishing repeatable.

```yaml
name: clinic-intake
type: dynamic
build: npm run build
run: npm start
port: 3000
readiness:
  path: /
resources:
  database:
    auto: true
    engine: postgresql
    size: xs
  storage:
    auto: true
domain: intake.apps.cliniciq.com
```

Resource values use the backend compose protocol:

```text
auto: true       -> provision and wire a new resource
select: <id>     -> attach an existing resource
false/omitted    -> do not attach that resource
```

Deployment URLs come from the backend response. The CLI should not guess a
domain from the tenant slug.

```text
default managed URL:       https://<slug>.<tenant-slug>.miosa.app
tenant deployment domain:  https://<slug>.apps.customer.com
custom deployment domain:  https://app.customer.com
```

Sandbox previews are separate:

```text
default preview URL:       https://<port>-<sandbox-slug>.sandbox.miosa.app
tenant preview domain:     https://<port>-<sandbox-slug>.sandbox.customer.com
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
