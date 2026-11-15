#!/usr/bin/env bash
# One lab scenario for haunted-scenario.service.
#   scenario.sh run     apply the next scenario of the rotation, wait, reset
#   scenario.sh reset   reset the lab (also run by ExecStopPost on stop and on failure)
# The rotation is error-spike, fog, dark-room; its position is kept in /var/lib/haunted/scenario-next.
# CHAOS_TOKEN comes from the environment of the unit. It goes to curl through a private header file, never through an argument.
set -euo pipefail

SCENARIOS=(error-spike fog dark-room)
STATE_FILE="${STATE_FILE:-/var/lib/haunted/scenario-next}"
WAIT_SECONDS="${WAIT_SECONDS:-1200}"
BASE_URL="http://127.0.0.1:${SUPERVISOR_PORT:-4100}"

fail() {
  echo "scenario: $*" >&2
  exit 1
}

[ -n "${CHAOS_TOKEN:-}" ] || fail "CHAOS_TOKEN is not set"

HEADER_FILE="$(mktemp)"
trap 'rm -f -- "$HEADER_FILE"' EXIT
chmod 600 "$HEADER_FILE"
printf 'Authorization: Bearer %s\n' "$CHAOS_TOKEN" >"$HEADER_FILE"

post() {
  curl --silent --show-error --fail --max-time 30 --request POST --header "@${HEADER_FILE}" --output /dev/null "${BASE_URL}$1"
}

reset_lab() {
  post /chaos/reset
  echo "scenario: lab reset"
}

run_next() {
  local index=0 raw=""
  if [ -r "$STATE_FILE" ]; then
    raw="$(head -c 8 "$STATE_FILE" | tr -d '[:space:]')"
  fi
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    index=$((raw % ${#SCENARIOS[@]}))
  fi
  local name="${SCENARIOS[$index]}"
  # The next position is written first, so a scenario that fails does not pin the rotation.
  printf '%s\n' "$(((index + 1) % ${#SCENARIOS[@]}))" >"$STATE_FILE"
  post "/chaos/scenarios/${name}/apply"
  echo "scenario: applied ${name}, waiting ${WAIT_SECONDS} s"
  sleep "$WAIT_SECONDS"
  reset_lab
}

case "${1:-}" in
  run) run_next ;;
  reset) reset_lab ;;
  *) fail "usage: scenario.sh run|reset" ;;
esac
