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
# env_guard <file> <profile>: env-guard.sh passes only with exit status 0 AND the line `env ok: <profile>` (a guard that did not run prints nothing)
env_guard() { "$CURRENT/deploy/server/env-guard.sh" --node /usr/local/bin/node "$1" "$2"; }
# The files of the release run as root (`ExecStartPre=+`), so hops must not be able to change one: no file under current/ has another owner
# than root or a write bit for group or other (find does not follow the link of current/ itself, so the trailing slash resolves it).
release_tree_locked() { [ -z "$(find "$CURRENT/" \( ! -user root -o -perm /022 \) ! -type l -print -quit)" ]; }
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
caddy_recent() { # `caddy version` prints "v2.6.2 h1:..."; the installed version must be at least CADDY_MIN_VERSION of versions.env
  local want have
  want="$(sed -n 's/^CADDY_MIN_VERSION=//p' "$(dirname "${BASH_SOURCE[0]}")/versions.env" | tail -n 1)"
  have="$(caddy version | awk '{ sub(/^v/, "", $1); print $1 }')"
  [ -n "$want" ] && [ -n "$have" ] && [ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n 1)" = "$want" ]
}
check "Caddy is at least the version of the Caddyfile" caddy_recent
check "systemd units are valid" systemd-analyze verify /etc/systemd/system/haunted-api.service /etc/systemd/system/haunted-lab.service /etc/systemd/system/haunted-scenario.service /etc/systemd/system/haunted-scenario.timer
check "release tree is root owned and not writable by hops" release_tree_locked
check "env guard accepts api.env" env_guard /etc/haunted/api.env api
check "env guard accepts lab.env" env_guard /etc/haunted/lab.env lab
same_read_token() ( # read the way the env guard reads: `LAB_READ_TOKEN = "x"` and `LAB_READ_TOKEN=x` are the same value
  { set +x; } 2>/dev/null # under `bash -x` the trace must never print the token; this subshell ends with the check
  a="$(/usr/local/bin/node "$CURRENT/scripts/read-env-value.mjs" /etc/haunted/api.env LAB_READ_TOKEN)" || exit 1
  b="$(/usr/local/bin/node "$CURRENT/scripts/read-env-value.mjs" /etc/haunted/lab.env LAB_READ_TOKEN)" || exit 1
  [ -n "$a" ] && [ "$a" = "$b" ]
)
check "api.env and lab.env share LAB_READ_TOKEN" same_read_token
KIRO_ENV=/etc/haunted/kiro.env
kiro_env_mode() { [ -f "$KIRO_ENV" ] && [ ! -L "$KIRO_ENV" ] && [ "$(stat -c '%U:%G %a' "$KIRO_ENV")" = "root:root 600" ]; }
kiro_whoami_key() ( # the key is read by root and handed to kiro-cli through the environment (never an argument, never printed)
  { set +x; } 2>/dev/null # under `bash -x` the trace must never print the key; this subshell ends with the check
  key="$(/usr/local/bin/node "$CURRENT/scripts/read-env-value.mjs" "$KIRO_ENV" KIRO_API_KEY)"
  [ -n "$key" ] || exit 1
  export KIRO_API_KEY="$key"
  runuser -u hops -- env HOME=/var/lib/hops /usr/local/bin/kiro-cli whoami
)
kiro_whoami_login() { runuser -u hops -- env -u KIRO_API_KEY HOME=/var/lib/hops /usr/local/bin/kiro-cli whoami; }
# "kiro-cli can authenticate for hops": with the key file, the API key must work (and the file must be root:root 0600);
# without it, the login of hops must. The line names the method, never a value.
if [ -e "$KIRO_ENV" ]; then
  check "kiro.env is root:root 0600" kiro_env_mode
  check "env guard accepts kiro.env" env_guard "$KIRO_ENV" kiro
  check "kiro-cli can authenticate for hops (api key)" kiro_whoami_key
else
  check "kiro-cli can authenticate for hops (login)" kiro_whoami_login
fi
check "Prometheus answers /-/ready" curl --fail --silent --max-time 5 http://127.0.0.1:9090/-/ready
check "the API answers /healthz" curl --fail --silent --max-time 5 http://127.0.0.1:3000/healthz

if [ "$FAILED" -ne 0 ]; then
  echo "preflight: FAILED"
  exit 1
fi
echo "preflight: all checks passed"
