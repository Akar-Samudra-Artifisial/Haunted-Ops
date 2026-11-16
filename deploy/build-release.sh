#!/usr/bin/env bash
# Builds the release tarball of the demo on the Mac. Nothing is compiled on the server.
#   HAUNTED_DOMAIN=<name>.sslip.io deploy/build-release.sh
# Writes deploy/out/haunted-ops-<shortsha>.tar.gz and the same name with .sha256.
# It refuses a dirty Git tree, a web build without VITE_DEMO_MODE=true (scripts/check-demo-build.mjs), and any forbidden item
# in the tree (scripts/release-check.mjs). It sets VITE_DEMO_MODE itself, whatever the environment says. The tarball is
# reproducible (deploy/pack-release.sh). It never commits, adds, stashes or checks out.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "build-release: $*" >&2
  exit 1
}

for tool in git node pnpm tar gzip find sort touch; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# 1. The tree must be clean, so that the tarball is exactly the commit it names.
if [ -n "$(git status --porcelain)" ]; then
  fail "the Git tree is not clean (commit or remove every change first)"
fi

# 2. The domain is baked into the web build (VITE_API_BASE_URL); it must be a plain DNS name.
HAUNTED_DOMAIN="${HAUNTED_DOMAIN:-}"
if ! printf '%s' "$HAUNTED_DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'; then
  fail "HAUNTED_DOMAIN must be a DNS name (for example the sslip.io name of the instance address)"
fi

COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=12 HEAD)"
COMMIT_EPOCH="$(git log -1 --format=%ct HEAD)"
NAME="haunted-ops-${SHORT}"
OUT="$ROOT/deploy/out"

# 3. Build. The shared and MCP packages are runtime imports of the API.
pnpm install --frozen-lockfile
pnpm --filter @haunted-ops/shared build
pnpm --filter @haunted-ops/exorcist-mcp build
pnpm --filter @haunted-ops/api build
VITE_DEMO_MODE=true VITE_API_BASE_URL="https://${HAUNTED_DOMAIN}" pnpm --filter @haunted-ops/web build

# 4. The variables must have reached every script of the bundle (Vite inlines them into import.meta.env).
node "$ROOT/scripts/check-demo-build.mjs" "$ROOT/apps/web/dist" "$HAUNTED_DOMAIN" || fail "the web build does not carry the demo settings"
# 5. Stage the tree.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/haunted-release.XXXXXX")"
cleanup() {
  rm -r -f -- "$STAGE"
}
trap cleanup EXIT

copy() {
  mkdir -p "$STAGE/$(dirname "$1")"
  cp -R "$ROOT/$1" "$STAGE/$1"
}

for path in \
  package.json pnpm-lock.yaml pnpm-workspace.yaml \
  apps/web/package.json apps/web/dist \
  apps/api/package.json apps/api/dist apps/api/prisma.config.ts apps/api/prisma/schema.prisma apps/api/prisma/migrations \
  packages/shared/package.json packages/shared/dist \
  packages/exorcist-mcp/package.json packages/exorcist-mcp/dist packages/exorcist-mcp/bin \
  .kiro/agents/exorcist.json \
  scripts/demo-env-check.mjs scripts/read-env-value.mjs scripts/demo-smoke.mjs \
  deploy/server; do
  [ -e "$ROOT/$path" ] || fail "missing: $path"
  copy "$path"
done

# The replays: only the files of fixtures/replays/*.json and the one README go in. The README keeps the folder in the tarball
# (pack-release.sh packs files only, so an empty folder would be lost and the seed would refuse the missing folder). The release check
# below refuses a file that has no review, one that does not validate and one edited after its review. Nothing in the folder
# may be a link, a folder or any other thing that is not a regular file: cp would follow a link out of the repository.
[ ! -L "$ROOT/fixtures/replays" ] || fail "fixtures/replays is a symbolic link"
replay_odd="$(find "$ROOT/fixtures/replays" -mindepth 1 ! -type f 2>/dev/null | head -n 1 || true)"
[ -z "$replay_odd" ] || fail "fixtures/replays holds something that is not a regular file: ${replay_odd#"$ROOT"/}"
[ -f "$ROOT/fixtures/replays/README.md" ] || fail "missing: fixtures/replays/README.md"
mkdir -p "$STAGE/fixtures/replays"
cp "$ROOT/fixtures/replays/README.md" "$STAGE/fixtures/replays/"
for replay in "$ROOT"/fixtures/replays/*.json; do
  [ -e "$replay" ] || continue
  cp "$replay" "$STAGE/fixtures/replays/"
done
# The manifest lists every chunk and source path and is not needed at run time.
if [ -d "$STAGE/apps/web/dist/.vite" ]; then
  rm -r -- "$STAGE/apps/web/dist/.vite"
fi

# built_at is the time of the commit (GNU date reads @seconds, BSD date takes -r seconds), so the file is the same on every build.
BUILT_AT="$(date -u -d "@${COMMIT_EPOCH}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${COMMIT_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"
cat >"$STAGE/RELEASE-INFO" <<EOF
commit=${COMMIT}
domain=${HAUNTED_DOMAIN}
demo_mode=true
built_at=${BUILT_AT}
EOF

# 6. Check the stage. A finding stops the build before any tarball exists.
node "$ROOT/scripts/release-check.mjs" "$STAGE" || fail "the release check refused the tree"

# 7. Tarball and checksum. The stage gets normal modes, owner root and the time of the commit, so two builds of one commit
# give the same sha256.
TARBALL="$OUT/${NAME}.tar.gz"
"$ROOT/deploy/pack-release.sh" "$STAGE" "$TARBALL" "$COMMIT_EPOCH"
printf '%s  %s\n' "$(sha256_of "$TARBALL")" "${NAME}.tar.gz" >"$TARBALL.sha256"
echo "build-release: wrote deploy/out/${NAME}.tar.gz and .sha256"
