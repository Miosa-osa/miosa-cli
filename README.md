# @miosa/cli

The official MIOSA command-line interface. Manage OpenComputers hosts from your shell.

```bash
npm install -g @miosa/cli
```

## Getting started

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
| `MIOSA_DEBUG` | Set to any value to enable debug output |

## Commands

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

### `miosa ssh <host> [--cmd "..."]`

Open an interactive PTY terminal session on a host.

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

### `miosa agent <host> "<task>" [--model] [--steps] [--timeout]`

Dispatch an AI agent task. Streams thoughts, tool calls, and results live.

```bash
miosa agent my-mac "run the test suite and fix any failing tests"
miosa agent my-mac "update all npm dependencies" --steps 20
miosa agent my-mac "optimize the database queries" --model nemotron-3-super
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
