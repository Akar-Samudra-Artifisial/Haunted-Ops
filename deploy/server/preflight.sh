#!/usr/bin/env bash
# State checks of the demo server. Run as root on the server. Prints one line per check and exits 1 when any fails.
# kiro-cli output is discarded: only its exit status is used, so no account detail is printed.
set -uo pipefail

[ "$(id -u)" -eq 0 ] || {
  echo "preflight: run as root" >&2
  exit 2
}

FAILED=0
check() { # check <name> <command...>
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    FAILED=1
  fi
}

CURRENT=/opt/haunted-ops/current
for unit in haunted-api haunted-lab caddy postgresql prometheus nftables haunted-scenario.timer; do
  check "unit $unit is active" systemctl is-active --quiet "$unit"
done
swap_on() { [ -n "$(swapon --noheadings --show=NAME)" ]; }
memory_free() { awk '/^MemAvailable:/ { exit !($2 > 300 * 1024) }' /proc/meminfo; }
disk_free() { [ "$(df --output=avail -k / | tail -n 1 | tr -d ' ')" -gt 3145728 ]; }
check "swap is on" swap_on
check "more than 300 MiB of memory is available" memory_free
check "more than 3 GiB of disk is free" disk_free
check "nftables table haunted is loaded" nft list table inet haunted
check "nftables file is valid" nft -c -f /etc/nftables.conf
caddy_valid() (
  set -a
  # shellcheck disable=SC1091
  . /etc/caddy/haunted.env
  set +a
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
)
check "Caddyfile is valid" caddy_valid
check "systemd units are valid" systemd-analyze verify /etc/systemd/system/haunted-api.service /etc/systemd/system/haunted-lab.service /etc/systemd/system/haunted-scenario.service /etc/systemd/system/haunted-scenario.timer
check "env guard accepts api.env" node "$CURRENT/scripts/demo-env-check.mjs" /etc/haunted/api.env api
check "env guard accepts lab.env" node "$CURRENT/scripts/demo-env-check.mjs" /etc/haunted/lab.env lab
same_read_token() {
  node -e '
    const fs = require("node:fs");
    const read = (f) => (fs.readFileSync(f, "utf8").match(/^LAB_READ_TOKEN=(.*)$/m) || [])[1];
    const a = read("/etc/haunted/api.env");
    process.exit(a && a === read("/etc/haunted/lab.env") ? 0 : 1);
  '
}
check "api.env and lab.env share LAB_READ_TOKEN" same_read_token
check "kiro-cli is logged in for hops" runuser -u hops -- env HOME=/var/lib/hops /usr/local/bin/kiro-cli whoami
check "the API answers /healthz" curl --fail --silent --max-time 5 http://127.0.0.1:3000/healthz

if [ "$FAILED" -ne 0 ]; then
  echo "preflight: FAILED"
  exit 1
fi
echo "preflight: all checks passed"
