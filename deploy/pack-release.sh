#!/usr/bin/env bash
# Packs a staged release tree into a reproducible tarball (called by build-release.sh).
#   deploy/pack-release.sh <stage-dir> <tarball> <epoch-seconds>
# It first normalises the stage: folders 0755, files 0644, deploy/server/*.sh 0755, every mtime set to <epoch>.
# The archive has owner and group 0 (root), sorted names, no extended attributes and gzip -n, so two builds of one commit
# give the same sha256, and the user hops on the server can read every file whatever the umask of the Mac was.
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "usage: pack-release.sh <stage-dir> <tarball> <epoch-seconds>" >&2
  exit 2
fi
STAGE_DIR="$1"
TARBALL="$2"
EPOCH="$3"
[ -d "$STAGE_DIR" ] || {
  echo "pack-release: no such folder: $STAGE_DIR" >&2
  exit 1
}
printf '%s' "$EPOCH" | grep -Eq '^[0-9]{1,12}$' || {
  echo "pack-release: the time must be whole seconds" >&2
  exit 2
}
# touch -t wants [[CC]YY]MMDDhhmm[.SS]; GNU date reads @seconds, BSD date takes -r seconds.
STAMP="$(date -u -d "@$EPOCH" +%Y%m%d%H%M.%S 2>/dev/null || date -u -r "$EPOCH" +%Y%m%d%H%M.%S)"
LIST="$(mktemp "${TMPDIR:-/tmp}/pack-release.XXXXXX")"
trap 'rm -f -- "$LIST"' EXIT
find "$STAGE_DIR" -type d -exec chmod 0755 {} +
find "$STAGE_DIR" -type f -exec chmod 0644 {} +
for script in "$STAGE_DIR"/deploy/server/*.sh; do
  if [ -f "$script" ]; then chmod 0755 "$script"; fi
done
find "$STAGE_DIR" -exec env TZ=UTC touch -h -t "$STAMP" {} +
(cd "$STAGE_DIR" && find . -type f | LC_ALL=C sort) >"$LIST"
if tar --version 2>&1 | grep -qi bsdtar; then
  OWNER_ARGS=(--uid 0 --gid 0 --uname root --gname root --numeric-owner --no-xattrs)
else
  OWNER_ARGS=(--owner=0 --group=0 --numeric-owner --sort=name "--mtime=@$EPOCH")
fi
mkdir -p "$(dirname "$TARBALL")"
COPYFILE_DISABLE=1 tar -C "$STAGE_DIR" -cf - "${OWNER_ARGS[@]}" -T "$LIST" | gzip -n -9 >"$TARBALL"
