# MIOSA for AI Agents

A universal guide for any AI agent (Claude, GPT, Gemini, open models) to drive MIOSA cloud infrastructure.

## What is MIOSA

MIOSA gives AI agents:

- **Sandboxes** — headless Firecracker microVMs for code execution
- **Computers** — full desktop VMs (Linux XFCE) for browser/GUI automation
- **Deployments** — git-backed web hosting with builds, releases, custom domains
- **Storage** — S3-compatible object storage
- **Databases** — managed Postgres, MySQL, Redis
- **Volumes** — persistent block storage attachable to computers

145 tools, exposed via MCP at `https://api.miosa.ai/api/v1/mcp` or locally via `miosa mcp serve`.

## Setup

### Get an API key

```bash
npm install -g @miosa/cli
miosa login
```

Or grab one from `https://miosa.ai/dashboard/api-keys` — format `msk_u_...`.

### Configure MCP

For any MCP-compatible agent (Claude Code, Cursor, Gemini CLI, OSS clients):

```json
{
  "mcpServers": {
    "miosa": {
      "command": "miosa",
      "args": ["mcp", "serve"],
      "env": { "MIOSA_API_KEY": "msk_..." }
    }
  }
}
```

Or hit the hosted endpoint directly with `Authorization: Bearer msk_...`.

## Universal conventions

Apply these whether you're using MCP, the REST API, or an SDK:

| Convention | Detail |
|---|---|
| **IDs** | Every tool takes `<resource>_id` first. `create_sandbox` returns one; reuse it. |
| **Status** | Poll `<resource>_get` until `status: "running"`. Never `active`. |
| **Sizes** | xs(1/2GB), small(2/4GB), medium(4/8GB), large(8/16GB), xl(16/32GB). Default `small`. |
| **Paths** | Writable inside VMs: `/workspace` (default cwd), `/home`, `/root`, `/tmp`, `/opt`, `/srv` |
| **Timeouts** | `exec` default 30s. Pass `timeout_ms: 120000` for `npm install` / `pip install`. |
| **Screenshots** | PNG 1024×768. Coordinates absolute pixels, (0,0) top-left. |

## The 5 core workflows

### Run code

```
create_sandbox → exec → read output → destroy_sandbox
```

### Automate a desktop

```
computer_create → desktop_screenshot → desktop_click/type → desktop_screenshot → repeat
```

### Deploy from git

```
deployment_create(repo_url) → deployment_env_set → deployment_publish
```

### Store and share files

```
storage_bucket_create → storage_object_upload → storage_presign (returns public URL)
```

### Provision a database

```
database_create(engine="postgres") → database_credentials → use connection string
```

## Decision tree

```
Need a screen / browser / GUI?
  YES → computer
  NO ↓

Need to run code or build something?
  YES → sandbox
  NO ↓

Deploying from GitHub?
  YES → deployment
  NO ↓

Need to store files?
  YES → storage (bucket + presign)
  NO ↓

Need a database?
  YES → database
```

## Tool catalog (145 tools)

All MCP tool names use `snake_case`. REST endpoints mirror them.

### Sandbox (18)
`create_sandbox`, `get_sandbox`, `list_sandboxes`, `destroy_sandbox`, `sandbox_pause`, `sandbox_resume`, `exec`, `exec_python`, `sandbox_write_file`, `sandbox_read_file`, `sandbox_list_files`, `sandbox_expose`, `sandbox_deploy`, `sandbox_logs`, `sandbox_snapshot_create`, `sandbox_snapshot_list`, `sandbox_snapshot_restore`, `sandbox_template_list`

### Computer (~50)
Lifecycle: `computer_create`, `computer_get`, `computer_list`, `computer_destroy`, `computer_start`, `computer_stop`, `computer_restart`, `computer_update`, `computer_wait`

Desktop input: `desktop_screenshot`, `desktop_click`, `desktop_double_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_move_cursor`, `computer_right_click`, `computer_drag`, `computer_hotkey`, `computer_mouse_down`, `computer_mouse_up`, `computer_key_down`, `computer_key_up`

Screen: `computer_get_screen_size`, `computer_get_cursor_position`, `computer_get_clipboard`, `computer_set_clipboard`

Windows: `computer_windows`, `computer_focus_window`, `computer_maximize_window`, `computer_minimize_window`, `computer_close_window`, `computer_set_window_size`, `computer_set_window_position`

Files & shell: `computer_bash`, `computer_write_file`, `computer_read_file`, `computer_list_files`, `computer_stat_file`, `computer_mkdir`, `computer_rename_file`, `computer_copy_file`, `computer_delete_file`

Apps & env: `computer_launch`, `computer_get_desktop_env`, `computer_set_wallpaper`, `computer_accessibility_tree`

Checkpoints: `computer_checkpoint_create`, `computer_checkpoint_list`, `computer_checkpoint_restore`, `computer_checkpoint_delete`

Services: `computer_service_create`, `computer_service_list`, `computer_service_start`, `computer_service_stop`, `computer_service_restart`, `computer_service_logs`, `computer_service_delete`

Env & networking: `computer_env_list`, `computer_env_set`, `computer_env_delete`, `computer_logs`, `computer_domain_add`, `computer_domain_list`, `computer_domain_delete`

### Deploy (13)
`deployment_create`, `deployment_list`, `deployment_get`, `deployment_delete`, `deployment_publish`, `deployment_rollback`, `deployment_env_list`, `deployment_env_set`, `deployment_logs`, `deployment_version_list`, `deployment_version_promote`

### Storage (8)
`storage_bucket_create`, `storage_bucket_list`, `storage_bucket_delete`, `storage_object_upload`, `storage_object_download`, `storage_object_list`, `storage_object_delete`, `storage_presign`

### Database (6)
`database_create`, `database_list`, `database_get`, `database_delete`, `database_credentials`, `database_logs`

### Volume (5)
`volume_create`, `volume_list`, `volume_attach`, `volume_detach`, `volume_delete`

### Workspace (6)
`workspace_create`, `workspace_list`, `workspace_get`, `workspace_update`, `workspace_stats`, `workspace_usage`

### Cron (6)
`cron_create`, `cron_list`, `cron_pause`, `cron_resume`, `cron_run_now`, `cron_delete`

### Webhooks (4)
`webhook_create`, `webhook_list`, `webhook_delete`, `webhook_test`

### Functions (4)
`function_create`, `function_list`, `function_invoke`, `function_delete`

### API keys & platform
`api_key_create`, `api_key_list`, `api_key_delete`, `billing_usage`, `billing_plan`, `region_list`

## Error handling

| Error | Cause | Fix |
|---|---|---|
| `not running` | Action on resource that isn't ready | Poll `<resource>_get` until `status: "running"` |
| `not found` | Bad ID | Verify with `<resource>_list` |
| `path outside allowed` | Wrote to restricted path | Use `/workspace`, `/home`, `/tmp` |
| `timeout` | exec exceeded `timeout_ms` | Increase up to 300000 |
| `rate limited` | Too many API calls | Back off 5s |
| OOM killed | Build exceeded RAM | Bump size to medium or larger |
| `Internal error` | Server bug | Retry once; report if persistent |

## SDKs

If you prefer typed clients over raw MCP:

- **Python**: `pip install miosa` — [github.com/Miosa-osa/miosa-python](https://github.com/Miosa-osa/miosa-python)
- **Elixir**: `{:miosa, "~> 1.0"}` — [github.com/Miosa-osa/miosa-elixir](https://github.com/Miosa-osa/miosa-elixir)
- **Node/TypeScript**: `@miosa/cli` includes a programmatic client — [github.com/Miosa-osa/miosa-cli](https://github.com/Miosa-osa/miosa-cli)

All SDKs use the same REST endpoints as the MCP server. Pick whichever feels native.

## Hosted documentation

- Full docs: https://miosa.ai/docs
- MCP guide: https://miosa.ai/docs/guides/mcp
- Quickstart: https://miosa.ai/docs/quickstart

## Repos

- https://github.com/Miosa-osa/miosa-mcp — Python MCP server
- https://github.com/Miosa-osa/miosa-cli — TypeScript CLI + MCP
- https://github.com/Miosa-osa/miosa-skills — Claude Code skills (this repo)
- https://github.com/Miosa-osa/miosa-python — Python SDK
- https://github.com/Miosa-osa/miosa-elixir — Elixir SDK
