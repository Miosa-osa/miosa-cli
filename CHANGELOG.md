# Changelog

All notable changes to @miosa/cli will be documented in this file.

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
