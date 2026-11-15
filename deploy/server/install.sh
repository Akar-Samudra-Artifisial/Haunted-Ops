#!/usr/bin/env bash
# Installs the Haunted Ops demo on a Debian 13 instance. Run as root, through SSM (there is no SSH).
#
#   HAUNTED_DOMAIN=<name>.sslip.io \
#   RELEASE_URL=https://<host>/haunted-ops-<shortsha>.tar.gz RELEASE_SHA256=<64 hex> \
#   LAB_REPO_URL=https://<host>/<owner>/Haunted-Lab.git LAB_COMMIT=<40 hex> \
#   bash install.sh
#
# Idempotent: a second run with the same release rewrites no file with the same content, never changes a secret and
# restarts nothing. Nothing is compiled here: the release holds the built files. The tarball is verified (sha256)
# before it is unpacked. kiro-cli must already be installed at /usr/local/bin/kiro-cli (docs/DEPLOY.md).
set -euo pipefail
umask 022
cd /

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"

STAGE="start"
CHANGED=0 # files or settings changed in this run
PUT_CHANGED=0
RESTART_API=0
RESTART_LAB=0
RELOAD_CADDY=0
RESTART_PROMETHEUS=0
RESTART_POSTGRES=0
RELOAD_UNITS=0
RELOAD_NFT=0
POLICY_RC_SET=0 # 1 while the temporary /usr/sbin/policy-rc.d made by this script exists
WORK="$(mktemp -d)"

on_exit() {
  local rc=$?
  rm -r -f -- "$WORK"
  # The apt guard must never outlive the script, also when apt fails.
  if [ "$POLICY_RC_SET" -eq 1 ]; then
    rm -f -- /usr/sbin/policy-rc.d
  fi
  if [ "$rc" -ne 0 ]; then
    echo "install: failed in stage: $STAGE" >&2
  fi
}
trap on_exit EXIT

log() { echo "install: $*"; }
fail() {
  echo "install: $*" >&2
  exit 1
}
stage() {
  STAGE="$1"
  log "stage $1"
}

# put <src> <dst> <mode> <owner:group>: writes dst only when its content, mode or owner differ. Sets PUT_CHANGED.
put() {
  local src="$1" dst="$2" mode="$3" owner="$4"
  PUT_CHANGED=0
  if [ -f "$dst" ] && cmp -s "$src" "$dst" \
    && [ "$(stat -c '%a' "$dst")" = "${mode#0}" ] \
    && [ "$(stat -c '%U:%G' "$dst")" = "$owner" ]; then
    return 0
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dst.new"
  mv -f -- "$dst.new" "$dst"
  PUT_CHANGED=1
  CHANGED=$((CHANGED + 1))
  log "wrote $dst"
}

env_value() { # env_value <file> <KEY>: the value of KEY in an env file, empty when absent
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# ---------------------------------------------------------------- arguments
stage "arguments"
[ "$(id -u)" -eq 0 ] || fail "run as root"
HAUNTED_DOMAIN="${HAUNTED_DOMAIN:-}"
RELEASE_URL="${RELEASE_URL:-}"
RELEASE_SHA256="${RELEASE_SHA256:-}"
LAB_COMMIT="${LAB_COMMIT:-}"
LAB_REPO_URL="${LAB_REPO_URL:-}"
printf '%s' "$HAUNTED_DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$' || fail "HAUNTED_DOMAIN is missing or not a DNS name"
printf '%s' "$RELEASE_URL" | grep -Eq '^(https://[^[:space:]@]+|/[^[:space:]]+)$' || fail "RELEASE_URL must be an https URL (no credentials) or an absolute path"
printf '%s' "$RELEASE_SHA256" | grep -Eq '^[0-9a-f]{64}$' || fail "RELEASE_SHA256 must be 64 lower-case hex characters"
printf '%s' "$LAB_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || fail "LAB_COMMIT must be a 40-character commit id"
printf '%s' "$LAB_REPO_URL" | grep -Eq '^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$' || fail "LAB_REPO_URL must be an https URL without credentials"
KIRO_BIN="/usr/local/bin/kiro-cli"
[ -x "$KIRO_BIN" ] || fail "kiro-cli is not installed at $KIRO_BIN (see docs/DEPLOY.md)"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
export DEBIAN_FRONTEND=noninteractive
export HOME=/root

# ---------------------------------------------------------------- swap
stage "swap"
if ! swapon --noheadings --show=NAME | grep -qx '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  CHANGED=$((CHANGED + 1))
  log "swap enabled"
fi
grep -q '^/swapfile ' /etc/fstab || {
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
  CHANGED=$((CHANGED + 1))
}
printf 'vm.swappiness=10\n' >"$WORK/sysctl"
put "$WORK/sysctl" /etc/sysctl.d/99-haunted.conf 0644 root:root
if [ "$PUT_CHANGED" -eq 1 ] || [ "$(cat /proc/sys/vm/swappiness)" != "10" ]; then
  sysctl -q -w vm.swappiness=10
fi

# ---------------------------------------------------------------- packages
stage "packages"
PACKAGES=(ca-certificates curl xz-utils git openssl caddy postgresql prometheus nftables)
MISSING=()
for p in "${PACKAGES[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  # Keep the packages from starting with their default settings (open ports) before our files are in place.
  POLICY_RC_SET=1
  printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
  chmod 755 /usr/sbin/policy-rc.d
  apt-get update -q
  apt-get install -y -q --no-install-recommends "${MISSING[@]}"
  rm -f -- /usr/sbin/policy-rc.d
  POLICY_RC_SET=0
  CHANGED=$((CHANGED + 1))
fi

# ---------------------------------------------------------------- users and folders
stage "users"
getent group haunted >/dev/null || groupadd --system haunted
for u in hops hlab; do
  getent group "$u" >/dev/null || groupadd --system "$u"
  id -u "$u" >/dev/null 2>&1 || {
    useradd --system --gid "$u" --home-dir "/var/lib/$([ "$u" = hops ] && echo hops || echo haunted-lab)" --shell /usr/sbin/nologin "$u"
    CHANGED=$((CHANGED + 1))
  }
  id -nG "$u" | tr ' ' '\n' | grep -qx haunted || usermod -aG haunted "$u"
done
install -d -o root -g haunted -m 0750 /etc/haunted
install -d -o hops -g hops -m 0750 /var/lib/hops
install -d -o hops -g hops -m 0700 /var/lib/hops/hunts
install -d -o hlab -g hlab -m 0750 /var/lib/haunted-lab
install -d -o hlab -g hlab -m 0700 /var/lib/haunted-lab/data
install -d -o hlab -g hlab -m 0750 /var/lib/haunted-lab/worktrees
install -d -o root -g root -m 0755 /opt/haunted-ops /opt/haunted-ops/releases
install -d -o caddy -g caddy -m 0750 /var/log/caddy

# ---------------------------------------------------------------- node
stage "node"
NODE_DIR="/opt/node-v${NODE_VERSION}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  curl --fail --silent --show-error --location --proto '=https' --max-time 300 -o "$WORK/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
  echo "${NODE_SHA256}  $WORK/node.tar.xz" | sha256sum --check --status || fail "the Node tarball does not match its pinned sha256"
  mkdir "$WORK/node"
  tar -xJf "$WORK/node.tar.xz" -C "$WORK/node" --strip-components=1
  mv -- "$WORK/node" "$NODE_DIR"
  CHANGED=$((CHANGED + 1))
fi
if [ "$(readlink /usr/local/bin/node 2>/dev/null || true)" != "$NODE_DIR/bin/node" ]; then
  ln -sfn "$NODE_DIR/bin/node" /usr/local/bin/node
  CHANGED=$((CHANGED + 1))
fi
# pnpm: the exact version of versions.env, from the registry tarball, checked against its pinned sha256 before it is used.
# Node 26 does not bundle corepack, so the tarball (a bundle that runs on Node alone) is the way in.
PNPM_DIR="/opt/pnpm-v${PNPM_VERSION}"
if [ ! -f "$PNPM_DIR/bin/pnpm.mjs" ]; then
  curl --fail --silent --show-error --location --proto '=https' --max-time 300 -o "$WORK/pnpm.tgz" "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz"
  echo "${PNPM_SHA256}  $WORK/pnpm.tgz" | sha256sum --check --status || fail "the pnpm tarball does not match its pinned sha256"
  mkdir "$WORK/pnpm"
  tar -xzf "$WORK/pnpm.tgz" -C "$WORK/pnpm" --strip-components=1 --no-same-owner
  chmod 0755 "$WORK/pnpm/bin/pnpm.mjs"
  mv -- "$WORK/pnpm" "$PNPM_DIR"
  CHANGED=$((CHANGED + 1))
  log "pnpm $PNPM_VERSION installed"
fi
if [ "$(readlink /usr/local/bin/pnpm 2>/dev/null || true)" != "$PNPM_DIR/bin/pnpm.mjs" ]; then
  ln -sfn "$PNPM_DIR/bin/pnpm.mjs" /usr/local/bin/pnpm
  CHANGED=$((CHANGED + 1))
fi

# ---------------------------------------------------------------- release: download and verify
stage "release"
REL_FILE="$WORK/release.tar.gz"
if [[ "$RELEASE_URL" == https://* ]]; then
  curl --fail --silent --show-error --location --proto '=https' --max-time 600 -o "$REL_FILE" "$RELEASE_URL"
else
  cp -- "$RELEASE_URL" "$REL_FILE"
fi
echo "${RELEASE_SHA256}  $REL_FILE" | sha256sum --check --status || fail "the release does not match RELEASE_SHA256 (nothing was unpacked)"
INFO="$(tar -xzf "$REL_FILE" -O ./RELEASE-INFO)" || fail "the release has no RELEASE-INFO"
REL_COMMIT="$(printf '%s\n' "$INFO" | sed -n 's/^commit=//p' | head -n 1)"
printf '%s' "$REL_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || fail "RELEASE-INFO has no valid commit"
[ "$(printf '%s\n' "$INFO" | sed -n 's/^domain=//p' | head -n 1)" = "$HAUNTED_DOMAIN" ] || fail "the release was built for another domain"
[ "$(printf '%s\n' "$INFO" | sed -n 's/^demo_mode=//p' | head -n 1)" = "true" ] || fail "the release was not built in demo mode"
REL_ID="${REL_COMMIT:0:12}-${RELEASE_SHA256:0:8}"
REL_DIR="/opt/haunted-ops/releases/$REL_ID"
REL_READY=0
if [ -f "$REL_DIR/.installed" ] && [ "$(cat "$REL_DIR/.installed")" = "$RELEASE_SHA256" ]; then
  REL_READY=1
fi

# The release must name the pnpm version that versions.env pins (and that was checked above).
REL_PM="$(tar -xzf "$REL_FILE" -O ./package.json | sed -n 's/^.*"packageManager": *"pnpm@\([^"]*\)".*$/\1/p' | head -n 1)"
[ "$REL_PM" = "$PNPM_VERSION" ] || fail "the release asks for pnpm ${REL_PM:-?}, versions.env pins ${PNPM_VERSION}"
if [ "$REL_READY" -eq 0 ]; then
  rm -r -f -- "$REL_DIR"
  mkdir -p "$REL_DIR"
  tar -xzf "$REL_FILE" -C "$REL_DIR" --no-same-owner
  chmod 0755 "$REL_DIR" "$REL_DIR"/deploy/server/*.sh
  # The install below runs as hops, so hops owns the folder until it is locked again (root:hops, read only).
  chown -R hops:hops "$REL_DIR"
fi

# ---------------------------------------------------------------- secrets and env files
stage "env files"
PW_DB=""
if [ ! -f /etc/haunted/api.env ] || [ ! -f /etc/haunted/lab.env ]; then
  LAB_READ=""
  [ -f /etc/haunted/api.env ] && LAB_READ="$(env_value /etc/haunted/api.env LAB_READ_TOKEN)"
  [ -z "$LAB_READ" ] && [ -f /etc/haunted/lab.env ] && LAB_READ="$(env_value /etc/haunted/lab.env LAB_READ_TOKEN)"
  [ -n "$LAB_READ" ] || LAB_READ="$(openssl rand -hex 24)"
  if [ ! -f /etc/haunted/api.env ]; then
    PW_DB="$(openssl rand -hex 24)"
    TEXT="$(cat "$HERE/env/api.env.example")"
    TEXT="${TEXT//__HAUNTED_DOMAIN__/$HAUNTED_DOMAIN}"
    TEXT="${TEXT//__DB_PASSWORD__/$PW_DB}"
    TEXT="${TEXT//CHANGE_ME_LAB_READ_TOKEN/$LAB_READ}"
    TEXT="${TEXT//CHANGE_ME_HUNT_ADMIN_TOKEN/$(openssl rand -hex 24)}"
    (umask 027 && printf '%s\n' "$TEXT" >/etc/haunted/api.env)
    chown root:hops /etc/haunted/api.env
    chmod 0640 /etc/haunted/api.env
    CHANGED=$((CHANGED + 1))
    log "created /etc/haunted/api.env"
  fi
  if [ ! -f /etc/haunted/lab.env ]; then
    TEXT="$(cat "$HERE/env/lab.env.example")"
    TEXT="${TEXT//CHANGE_ME_LAB_READ_TOKEN/$LAB_READ}"
    TEXT="${TEXT//CHANGE_ME_CHAOS_TOKEN/$(openssl rand -hex 24)}"
    (umask 027 && printf '%s\n' "$TEXT" >/etc/haunted/lab.env)
    chown root:hlab /etc/haunted/lab.env
    chmod 0640 /etc/haunted/lab.env
    CHANGED=$((CHANGED + 1))
    log "created /etc/haunted/lab.env"
  fi
  unset TEXT LAB_READ
fi
[ "$(env_value /etc/haunted/api.env WEB_ORIGIN)" = "https://${HAUNTED_DOMAIN}" ] || fail "/etc/haunted/api.env names another domain; edit WEB_ORIGIN there first"
node "$REL_DIR/scripts/demo-env-check.mjs" /etc/haunted/api.env api
node "$REL_DIR/scripts/demo-env-check.mjs" /etc/haunted/lab.env lab
printf 'HAUNTED_DOMAIN=%s\n' "$HAUNTED_DOMAIN" >"$WORK/caddy.env"
put "$WORK/caddy.env" /etc/caddy/haunted.env 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && RELOAD_CADDY=1

# ---------------------------------------------------------------- postgresql
stage "postgresql"
for d in /etc/postgresql/*/main/conf.d; do
  [ -d "$d" ] || continue
  put "$HERE/postgres/haunted.conf" "$d/haunted.conf" 0644 root:root
  [ "$PUT_CHANGED" -eq 1 ] && RESTART_POSTGRES=1
done
systemctl enable --now postgresql >/dev/null 2>&1
if [ "$RESTART_POSTGRES" -eq 1 ]; then
  systemctl restart postgresql
fi
# Wait for the cluster, then create the role and database once.
for _ in $(seq 1 30); do
  runuser -u postgres -- psql -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
runuser -u postgres -- psql -tAc 'SELECT 1' >/dev/null 2>&1 || fail "PostgreSQL does not answer"
if [ "$(runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'hops'")" != "1" ]; then
  [ -n "$PW_DB" ] || PW_DB="$(env_value /etc/haunted/api.env DATABASE_URL | sed -n 's|^postgresql://hops:\([^@]*\)@.*|\1|p')"
  [ -n "$PW_DB" ] || fail "no database password in /etc/haunted/api.env"
  # The password goes through stdin, never through an argument.
  printf "CREATE ROLE hops LOGIN PASSWORD '%s';\n" "$PW_DB" | runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q
  CHANGED=$((CHANGED + 1))
  log "created the database role"
fi
if [ "$(runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'haunted'")" != "1" ]; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE haunted OWNER hops'
  CHANGED=$((CHANGED + 1))
  log "created the database"
fi
unset PW_DB

# ---------------------------------------------------------------- release: dependencies, migrations, link
stage "release install"
if [ "$REL_READY" -eq 0 ]; then
  install -d -o hops -g hops -m 0750 /var/lib/hops/pnpm-store
  as_hops() { runuser -u hops -- env HOME=/var/lib/hops CI=true "$@"; }
  # Only the API and the workspace packages it needs, as hops, with lifecycle scripts off. Their development dependencies come
  # along because the Prisma CLI (migrations) is one of them. The compiled Prisma client is already in apps/api/dist, so there
  # is no `prisma generate` on the server.
  (
    cd "$REL_DIR"
    as_hops pnpm install --frozen-lockfile --ignore-scripts --filter @haunted-ops/api... --store-dir /var/lib/hops/pnpm-store --package-import-method copy
    # The one script that runs: the postinstall of @prisma/engines downloads the schema engine that `migrate deploy` needs
    # (Prisma checks its checksum). It is named and justified in docs/DEPLOY.md.
    as_hops pnpm --filter @haunted-ops/api rebuild @prisma/engines
  )
  (
    DATABASE_URL="$(env_value /etc/haunted/api.env DATABASE_URL)"
    export DATABASE_URL
    cd "$REL_DIR/apps/api"
    as_hops "$REL_DIR/apps/api/node_modules/.bin/prisma" migrate deploy --config "$REL_DIR/deploy/server/prisma.config.mjs"
    # Seeding runs as the API user, like the API itself.
    as_hops /usr/local/bin/node "$REL_DIR/deploy/server/seed.mjs"
  )
  printf '%s' "$RELEASE_SHA256" >"$REL_DIR/.installed"
  # Lock the release: owner root, group hops, nobody can write. Caddy reads the web files as "other".
  chown -R root:hops "$REL_DIR"
  chmod -R u-w,go-w,a+rX "$REL_DIR"
  CHANGED=$((CHANGED + 1))
fi
CURRENT_TARGET="$(readlink /opt/haunted-ops/current 2>/dev/null || true)"
if [ "$CURRENT_TARGET" != "$REL_DIR" ]; then
  if [ -n "$CURRENT_TARGET" ]; then
    ln -sfn "$CURRENT_TARGET" /opt/haunted-ops/previous
  fi
  ln -sfn "$REL_DIR" /opt/haunted-ops/current.new
  mv -T -- /opt/haunted-ops/current.new /opt/haunted-ops/current
  RESTART_API=1
  CHANGED=$((CHANGED + 1))
  log "current is now $REL_ID"
fi

# ---------------------------------------------------------------- lab
stage "lab"
LAB_DIR=/opt/haunted-lab
LAB_GIT=(git -c safe.directory="$LAB_DIR" -C "$LAB_DIR")
[ -d "$LAB_DIR" ] || install -d -o root -g root -m 0755 "$LAB_DIR"
if [ ! -d "$LAB_DIR/.git" ]; then
  git -c safe.directory="$LAB_DIR" clone --quiet "$LAB_REPO_URL" "$LAB_DIR"
  CHANGED=$((CHANGED + 1))
fi
if ! "${LAB_GIT[@]}" cat-file -e "${LAB_COMMIT}^{commit}" 2>/dev/null; then
  "${LAB_GIT[@]}" fetch --quiet origin
fi
"${LAB_GIT[@]}" merge-base --is-ancestor "$LAB_COMMIT" origin/main || fail "LAB_COMMIT is not part of the history of main"
LAB_NOW="$("${LAB_GIT[@]}" rev-parse HEAD)"
LAB_MAIN="$("${LAB_GIT[@]}" rev-parse --verify --quiet refs/heads/main || true)"
if [ "$LAB_NOW" != "$LAB_COMMIT" ] || [ "$LAB_MAIN" != "$LAB_COMMIT" ]; then
  "${LAB_GIT[@]}" checkout --quiet --detach "$LAB_COMMIT"
  # The lab boots its services from the local heads of this checkout: main is the pinned commit.
  "${LAB_GIT[@]}" branch --quiet --force main "$LAB_COMMIT"
  RESTART_LAB=1
  CHANGED=$((CHANGED + 1))
  log "lab is at $LAB_COMMIT"
fi
# The scenario branches are the ones of the public repository, copied as they are (read only; nothing is planted or pushed).
while read -r ref; do
  name="${ref#refs/remotes/origin/}"
  want="$("${LAB_GIT[@]}" rev-parse "$ref")"
  have="$("${LAB_GIT[@]}" rev-parse --verify --quiet "refs/heads/$name" || true)"
  if [ "$want" != "$have" ]; then
    "${LAB_GIT[@]}" branch --quiet --force "$name" "$want"
    RESTART_LAB=1
  fi
done < <("${LAB_GIT[@]}" for-each-ref --format='%(refname)' 'refs/remotes/origin/scenario/')
if [ "$(cat /var/lib/haunted-lab/installed-commit 2>/dev/null || true)" != "$LAB_COMMIT" ] || [ ! -d "$LAB_DIR/node_modules" ]; then
  (
    # Root runs this install because the firewall holds hlab to loopback. Scripts are off; the tree is handed to hlab below.
    cd "$LAB_DIR"
    CI=true pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /opt/haunted-ops/pnpm-store
  )
  printf '%s' "$LAB_COMMIT" >/var/lib/haunted-lab/installed-commit
  RESTART_LAB=1
  CHANGED=$((CHANGED + 1))
fi
chown -R hlab:hlab "$LAB_DIR"

# ---------------------------------------------------------------- configuration files
stage "configuration"
SRC="$REL_DIR/deploy/server"
for unit in haunted-api.service haunted-lab.service haunted-scenario.service haunted-scenario.timer; do
  put "$SRC/systemd/$unit" "/etc/systemd/system/$unit" 0644 root:root
  if [ "$PUT_CHANGED" -eq 1 ]; then
    RELOAD_UNITS=1
    case "$unit" in
      haunted-api.service) RESTART_API=1 ;;
      haunted-lab.service) RESTART_LAB=1 ;;
    esac
  fi
done
put "$SRC/systemd/dropins/prometheus.service.d/haunted.conf" /etc/systemd/system/prometheus.service.d/haunted.conf 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && {
  RELOAD_UNITS=1
  RESTART_PROMETHEUS=1
}
put "$SRC/systemd/dropins/caddy.service.d/haunted.conf" /etc/systemd/system/caddy.service.d/haunted.conf 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && {
  RELOAD_UNITS=1
  RELOAD_CADDY=1
}
put "$SRC/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && RESTART_PROMETHEUS=1
put "$SRC/prometheus/targets/lab.json" /etc/prometheus/targets/lab.json 0644 root:root
put "$SRC/Caddyfile" /etc/caddy/Caddyfile 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && RELOAD_CADDY=1
put "$SRC/nftables.conf" /etc/nftables.conf 0644 root:root
[ "$PUT_CHANGED" -eq 1 ] && RELOAD_NFT=1
nft list table inet haunted >/dev/null 2>&1 || RELOAD_NFT=1

if [ "$RELOAD_UNITS" -eq 1 ]; then
  systemctl daemon-reload
fi
if [ "$RELOAD_NFT" -eq 1 ]; then
  nft -c -f /etc/nftables.conf
  nft -f /etc/nftables.conf
  CHANGED=$((CHANGED + 1))
  log "firewall loaded"
fi
systemctl enable nftables >/dev/null 2>&1
if [ "$RELOAD_CADDY" -eq 1 ]; then
  (
    set -a
    # shellcheck disable=SC1091
    . /etc/caddy/haunted.env
    set +a
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  ) || fail "the Caddyfile is not valid"
fi

# ---------------------------------------------------------------- start
stage "start"
systemctl enable prometheus caddy haunted-lab haunted-api haunted-scenario.timer >/dev/null 2>&1
if [ "$RESTART_PROMETHEUS" -eq 1 ]; then systemctl restart prometheus; else systemctl start prometheus; fi
if [ "$RESTART_LAB" -eq 1 ]; then systemctl restart haunted-lab; else systemctl start haunted-lab; fi
if [ "$RESTART_API" -eq 1 ]; then systemctl restart haunted-api; else systemctl start haunted-api; fi
if [ "$RELOAD_CADDY" -eq 1 ] && systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
systemctl start haunted-scenario.timer
if [ "$RESTART_API" -eq 1 ]; then
  for _ in $(seq 1 60); do
    curl --fail --silent --max-time 3 -o /dev/null http://127.0.0.1:3000/healthz && break
    sleep 1
  done
  curl --fail --silent --max-time 3 -o /dev/null http://127.0.0.1:3000/healthz || fail "the API does not answer /healthz (see journalctl -u haunted-api)"
fi

stage "done"
log "finished, $CHANGED change(s)"
