# MIOSA for Claude Code

This file teaches Claude Code how to use MIOSA effectively. Drop it in any project's root (or your home directory) and Claude will follow these conventions.

## When you need cloud infrastructure

This project uses MIOSA cloud infrastructure (Firecracker microVMs). The five `miosa-*` skills in `~/.claude/skills/` handle everything — you don't need to memorize the 145 tools.

| User asks for | Use skill |
|---|---|
| Run code, test a script, build something | `miosa-sandbox` |
| Browser automation, GUI, screenshot/click | `miosa-computer` |
| Deploy a web app from GitHub | `miosa-deploy` |
| Database, storage bucket, volume, cron | `miosa-data` |
| General "how do I X with MIOSA" | `miosa-mcp` |

Skills load automatically when their trigger phrases match. You can also invoke directly with `/miosa-sandbox`, etc.

## Core conventions (apply always)

- **Resource IDs** flow through everything: `create_sandbox` returns an ID, pass it to every subsequent call.
- **Status polling**: `running` means ready. Never `active`. Poll `get_sandbox` / `computer_get` / etc.
- **Default sandbox size**: `small` (4GB). Builds need `medium` (8GB) minimum — `small` will OOM on `npm install` of large dependency trees.
- **File paths**: write to `/workspace` (the canonical cwd). Also writable: `/home`, `/root`, `/tmp`, `/opt`, `/srv`. Anything else returns `path outside allowed`.
- **exec timeouts**: default 30s. Always pass `timeout_ms: 120000` for `npm install` or `pip install`.

## Always destroy when done

Sandboxes and computers bill while running. End every workflow with `destroy_sandbox` or `computer_destroy` unless the user explicitly wants the resource kept alive.

```python
try:
    id = create_sandbox(...)
    # do work
finally:
    destroy_sandbox(sandbox_id=id)
```

## The desktop loop (non-negotiable)

For any GUI task:

```
1. desktop_screenshot   → see current state
2. visually identify the target
3. desktop_click / desktop_type / desktop_key
4. desktop_screenshot   → verify
5. repeat
```

Never click without screenshotting first. Never assume an action worked — verify with a follow-up screenshot.

## Snapshots save real time

If you're about to do an expensive setup (install dependencies, log in to a service, build a project), snapshot afterwards:

```
sandbox_snapshot_create(sandbox_id=id, name="after-deps")
computer_checkpoint_create(computer_id=id, name="logged-in")
```

Next run, restore in ~1s instead of redoing the setup.

## Heredocs beat write_file

Writing many files? A single `exec` with shell heredocs is much faster than N `sandbox_write_file` calls:

```
exec(sandbox_id=id, command="""
mkdir -p /workspace/src
cat > /workspace/src/index.ts << 'EOF'
export const add = (a, b) => a + b
EOF
""")
```

## When asked to deploy

Never deploy without setting env vars first:

```
1. deployment_create(repo_url=...)
2. deployment_env_set(env={...})         # BEFORE publish
3. deployment_publish(deployment_id=id)
4. deployment_logs(deployment_id=id)     # watch build
```

If a deploy fails, check `deployment_logs` first. Don't suggest rebuilding without diagnosing.

## Errors are not failures

Many MIOSA errors are recoverable. Follow the table:

| Error | Action |
|---|---|
| `not running` | Wait, then poll `get_sandbox` |
| `envd_timeout` | VM still booting, retry after 5s |
| `timeout` | Increase `timeout_ms` |
| `path outside allowed` | Switch to `/workspace` |
| `OOM` | Recreate with bigger size |

Only escalate to the user for: auth failures, billing/quota errors, persistent `Internal error` after one retry.

## Tools to prefer

When the user could plausibly use either:

- **Sandbox over Computer** unless a screen is genuinely needed (sandbox is faster, cheaper, easier)
- **`sandbox_deploy` over `deployment_create`** when the user already has a working sandbox
- **`storage_presign` over emailing files** when they need to share something
- **`computer_checkpoint_create` over re-running setup** when iterating on browser automation

## When to ask vs when to act

Act without asking:
- Creating a sandbox to run code the user just shared
- Destroying a sandbox after a successful run
- Setting `timeout_ms: 120000` for installs

Ask first:
- Destroying a sandbox/computer the user might want to keep
- Switching from `small` to `large` (cost implication)
- Deploying to production (`deployment_publish`)
- Deleting a database or bucket

## Reference

- Skills repo: https://github.com/Miosa-osa/miosa-skills
- Full docs: https://miosa.ai/docs
- MCP catalog: https://miosa.ai/docs/guides/mcp
