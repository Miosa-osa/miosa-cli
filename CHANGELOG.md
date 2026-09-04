# Changelog

## [1.3.4] - 2026-09-04

### Fixed
- JSON error output preserves the server's retryability: 429 and 5xx stay `retryable: true`, 501 is no longer reported as retryable, and `request_id` is preserved (#103).

All notable changes to @miosa/cli will be documented in this file.

## [1.3.3] - 2026-09-02

### Added
- `sandbox create` now sends an auto-generated UUID `Idempotency-Key` (unless `--idempotency-key` is given). The same key is reused across all retries so a retried create dedups to the same sandbox instead of billing a duplicate VM. Applies to `sandbox create` (typed flags and `--data`) and the `mcp serve` `sandbox_create` tool.
- Bounded exponential-backoff retry (429/500/502/503/504, matching the SDK policy) on the `sandbox create` POST — now safe because the create carries a stable idempotency key. `MiosaClient.apiPostWithRetry()` provides the shared retry transport.

### Changed
- `sandbox create --wait` and `sandbox wait` now confirm **command-readiness** (all platform readiness components attached, via `GET /sandboxes/:id/readiness`, mirroring the server's `command_path_ready?`) after the sandbox reaches `running`, so a successful wait guarantees `exec` will not return `409 SANDBOX_NOT_COMMAND_READY`. A missing readiness endpoint on older servers is tolerated.

## [1.3.2] - 2026-09-01

### Fixed
- The shared SSE parser (`parseSse`, used by `exec`, `watch`, `logs`, `up`,
  `runs`, `builds`, `shell`, `databases`, and `deploy`) read a `data`/`output`
  field for `stdout`/`stderr` frames, but the sandbox `exec/stream` endpoint
  sends `data: {"line": "..."}`. Every stdout/stderr line from a sandbox
  exec/stream call silently became an empty string — indistinguishable from
  the stream producing zero events. It now reads `line` first, falling back
  to `data`/`output` for any other producer.
- Every SSE request in `MiosaClient` (`apiStream`, `streamJob`, `computerExec`,
  `dispatchAgent`, `streamDeploymentLogs`, `streamBuildLogs`, `watchEvents`,
  `watchComputerEvents`) now sends `Accept: text/event-stream, application/json, */*`
  instead of a bare `text/event-stream`, matching the fix already applied to
  the databases stream route and defensively preventing the same 406 class of
  bug everywhere else.

## [1.3.1] - 2026-09-01

### Fixed
- `miosa doctor` no longer reports the "Action authority / catalog mismatch"
  warning when the control plane simply advertises capabilities newer than the
  CLI. A server that is only *ahead* of the CLI is benign, forward-compatible
  drift: the CLI never invokes a capability it has no name for, and the control
  plane denies unknown capabilities regardless. Only `missing` and `stale`
  capabilities (genuine CLI<->server contract hazards) now affect the check;
  server-ahead capabilities are reported informationally.

### Changed
- Synced the pinned action-capability catalog with the control plane, adding the
  client-facing `computer.list.apps`, `computer.list.surfaces`,
  `computer.scroll.to`, `computer.set.value`, and `computer.triple.click`
  capabilities. Platform-internal `admin.*` capabilities remain excluded from
  the CLI contract.

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
