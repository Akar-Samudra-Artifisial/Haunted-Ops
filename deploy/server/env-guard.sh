#!/usr/bin/env bash
# Runs the env guard of this release on one env file and passes ONLY when node exited 0 AND the guard printed the line
# `env ok: <profile>`. The guard script (scripts/demo-env-check.mjs) can exit 0 without having checked anything, for
# example when it was started through a link and did not run main(); that must never count as a pass. Used by the systemd
# units (ExecStartPre), install.sh and preflight.sh, so every caller has the same rule.
#   env-guard.sh --node <absolute path of node> <env file> <profile>      profile: api, lab or kiro
# The node binary comes from the option only, never from the environment: an `EnvironmentFile` of a unit can set any variable
# and would otherwise choose the program that judges the file (the guard also refuses a `HAUNTED_NODE` key in its profiles).
# The release folder is two levels above this script (deploy/server/), found through realpath, not a fixed path.
# The guard output (names only, never values) goes to stderr. Exit 0 = accepted, 1 = anything else.
set -u
fail() {
  printf 'env-guard: %s\n' "$1" >&2
  exit 1
}
[ "$#" -eq 4 ] && [ "$1" = "--node" ] || fail "usage: env-guard.sh --node <node> <env file> <profile>"
NODE="$2"
FILE="$3"
PROFILE="$4"
case "$NODE" in
  /*) ;;
  *) fail "--node must be an absolute path" ;;
esac
{ [ -f "$NODE" ] && [ -x "$NODE" ]; } || fail "--node is not an executable file"
SELF="$(realpath "${BASH_SOURCE[0]}" 2>/dev/null)" || fail "cannot resolve the script path"
RELEASE="$(dirname "$(dirname "$(dirname "$SELF")")")"
[ -f "$RELEASE/scripts/demo-env-check.mjs" ] || fail "the release has no scripts/demo-env-check.mjs"
OUT="$("$NODE" "$RELEASE/scripts/demo-env-check.mjs" "$FILE" "$PROFILE" 2>&1)"
STATUS=$?
[ -z "$OUT" ] || printf '%s\n' "$OUT" >&2
[ "$STATUS" -eq 0 ] || fail "the guard refused $PROFILE (exit $STATUS)"
printf '%s\n' "$OUT" | grep -qxF "env ok: $PROFILE" || fail "the guard did not print its ok line for $PROFILE"
exit 0
