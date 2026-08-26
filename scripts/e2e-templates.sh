#!/usr/bin/env bash
# End-to-end exercise of `miosa templates ...` against scripts/fake-platform-api.mjs.
#
# Runs the real built binary (dist/bin/miosa.js) as a real child process with a
# real argv, a real HTTP round-trip, real stdout/stderr and a real exit code.
# Nothing here touches production or a customer tenant: MIOSA_ENDPOINT points at
# a loopback server and MIOSA_API_KEY is a throwaway string the fake never checks.
#
# Usage: scripts/e2e-templates.sh <scenario> <miosa args...>
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scenario="$1"
shift

log="$(mktemp)"
node "$repo_root/scripts/fake-platform-api.mjs" --scenario "$scenario" >"$log" 2>&1 &
server_pid=$!
# shellcheck disable=SC2064
trap "kill $server_pid 2>/dev/null; rm -f $log" EXIT

for _ in $(seq 1 100); do
  base="$(sed -n 's/^listening //p' "$log")"
  [ -n "$base" ] && break
  sleep 0.05
done

if [ -z "${base:-}" ]; then
  echo "fake api never came up:" >&2
  cat "$log" >&2
  exit 90
fi

echo "--- scenario=$scenario cmd: miosa $* ---"
env -u MIOSA_JSON -u MIOSA_DEBUG \
  MIOSA_ENDPOINT="$base" \
  MIOSA_API_KEY="msk_u_e2e_fake_not_a_real_credential" \
  MIOSA_NO_COLOR=1 \
  HOME="$(mktemp -d)" \
  node "$repo_root/dist/bin/miosa.js" "$@"
code=$?
echo "--- exit=$code ---"
exit "$code"
