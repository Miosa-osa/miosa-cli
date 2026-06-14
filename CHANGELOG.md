# Changelog

All notable changes to @miosa/cli will be documented in this file.

## [1.0.67] - 2026-06-14

### Fixed
- Updated `miosa capabilities` guidance so `sandbox prompt` describes the
  durable `/agent-runs` path instead of the old raw exec path.

## [1.0.66] - 2026-06-14

### Changed
- `miosa sandbox prompt` now dispatches through the durable `/api/v1/agent-runs`
  backend instead of bypassing it with raw sandbox exec.
- Added backend-aligned prompt providers: `claude`, `claude-code`, `codex`,
  `hermes`, `osa`, `pi`, and `custom` with `--runtime-command`.

## [1.0.54] - 2026-06-10

### Changed
- Publish workflow now uses npm Trusted Publishing provenance instead of an empty `NPM_TOKEN` secret.

## [1.0.53] - 2026-06-10

### Added
- `miosa docker-deploy ensure --wait` waits for the workspace appliance host to become active and healthy.
- `miosa docker-deploy doctor <deployment-id>` verifies Docker Deploy metadata, host readiness, appliance route, and public URL health.
- `miosa app plan --goal docker-deploy --json` now includes the doctor command as the post-publish proof step.

## [1.0.1] - 2026-05-22

### Added
- `miosa logs` — unified log streaming for computers, deployments, sandboxes
- `miosa env` — environment variable management (list/set/unset/pull)
- `miosa scale` — instance scaling and resizing
- `miosa rollback` — deployment rollback
- `miosa releases` — release management (list/get/promote)
- `miosa builds` — build history and logs
- `miosa regions` — list available regions
- `miosa teams` — team/org management (list/invite/remove/role)
- `miosa billing` — usage, invoices, plan info
- `miosa templates` — sandbox template management
- Storage object operations (upload/download/list/delete/presign)
- Database backup/restore/logs

## [0.2.0] - 2026-05-18

### Added
- 90+ commands across desktop, files, sandboxes, deploy, databases, functions, cron, infra
- Premium commands: up, shell, watch, agent, dev, run, snapshot, tunnel, mcp serve
- MCP server (`miosa mcp serve`) for Claude Code/Cursor/Windsurf integration
- `miosa status` dashboard with parallel API calls
- `miosa doctor` diagnostics
- `miosa whoami` with cached auth
- `miosa config` management

## [0.1.0] - 2026-04-19

### Added
- Initial release with basic computer and host management
