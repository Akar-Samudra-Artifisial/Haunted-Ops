#!/usr/bin/env bash
# Points /opt/haunted-ops/current at the previous release and restarts the API. Run as root.
# Database migrations are not undone: a release with a destructive migration needs its own plan.
set -euo pipefail

fail() {
  echo "rollback: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
CURRENT="$(readlink /opt/haunted-ops/current 2>/dev/null || true)"
PREVIOUS="$(readlink /opt/haunted-ops/previous 2>/dev/null || true)"
[ -n "$CURRENT" ] || fail "there is no current release"
[ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] || fail "there is no previous release"
[ "$PREVIOUS" != "$CURRENT" ] || fail "the previous release is the current one"

ln -sfn "$PREVIOUS" /opt/haunted-ops/current.new
mv -T -- /opt/haunted-ops/current.new /opt/haunted-ops/current
# A second rollback goes forward again.
ln -sfn "$CURRENT" /opt/haunted-ops/previous
systemctl restart haunted-api
for _ in $(seq 1 60); do
  curl --fail --silent --max-time 3 -o /dev/null http://127.0.0.1:3000/healthz && break
  sleep 1
done
curl --fail --silent --max-time 3 -o /dev/null http://127.0.0.1:3000/healthz || fail "the API does not answer /healthz after the rollback"
echo "rollback: current is now $(basename "$PREVIOUS")"
