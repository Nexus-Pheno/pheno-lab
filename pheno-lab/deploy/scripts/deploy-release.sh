#!/usr/bin/env bash
set -euo pipefail

ARTIFACT="${1:-}"
RELEASE_ID="${2:-}"
BASE=/srv/pheno-lab
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
ENV_FILE=/etc/pheno-lab/pheno-lab.env
SERVICE=pheno-lab.service

if [[ -z "$ARTIFACT" || -z "$RELEASE_ID" ]]; then
  echo "usage: sudo $0 /absolute/path/release.tar.gz <release-id>" >&2
  exit 2
fi
if [[ ! "$RELEASE_ID" =~ ^[0-9]{8}-[0-9]{3}$ ]]; then
  echo "release-id must match YYYYMMDD-NNN" >&2
  exit 2
fi
if [[ "${ARTIFACT:0:1}" != "/" || ! -f "$ARTIFACT" ]]; then
  echo "artifact must be an existing absolute path" >&2
  exit 2
fi
if [[ ! -f "$ARTIFACT.sha256" ]]; then
  echo "missing checksum: $ARTIFACT.sha256" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing environment file: $ENV_FILE" >&2
  exit 2
fi

(
  cd "$(dirname "$ARTIFACT")"
  sha256sum --check "$(basename "$ARTIFACT").sha256"
)
install -d -m 0750 -o root -g pheno "$BASE" "$RELEASES"

FINAL="$RELEASES/$RELEASE_ID"
STAGING="$RELEASES/.staging-$RELEASE_ID-$$"
if [[ -e "$FINAL" || -e "$STAGING" ]]; then
  echo "release target already exists" >&2
  exit 2
fi

mkdir -m 0750 "$STAGING"
tar -xzf "$ARTIFACT" -C "$STAGING"
APP="$STAGING/pheno-lab"
for required in package.json .next node_modules prisma/migrations scripts/backup.sh; do
  if [[ ! -e "$APP/$required" ]]; then
    echo "artifact is missing pheno-lab/$required; staging retained at $STAGING" >&2
    exit 1
  fi
done
chown -R root:pheno "$STAGING"
chmod -R go-w "$STAGING"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${DATABASE_URL:?DATABASE_URL is required in $ENV_FILE}"
: "${HEALTHCHECK_TOKEN:?HEALTHCHECK_TOKEN is required in $ENV_FILE}"
export NODE_ENV=production

if [[ "$(/usr/bin/node -p 'process.versions.node.split(`.`)[0]')" != "24" ]]; then
  echo "/usr/bin/node must be Node.js 24" >&2
  exit 1
fi

(
  cd "$APP"
  /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/validate-runtime-config.ts
)

# Migrations run before the code switch. They must therefore remain compatible
# with the currently running N-1 release (expand/contract is mandatory).
(
  cd "$APP"
  /usr/bin/node node_modules/prisma/build/index.js migrate deploy
  /usr/bin/node node_modules/tsx/dist/cli.mjs scripts/encrypt-ai-keys.ts
)

PREVIOUS=""
if [[ -L "$CURRENT" ]]; then
  PREVIOUS="$(readlink -f "$CURRENT")"
fi

mv "$STAGING" "$FINAL"
NEXT_LINK="$BASE/.current-$RELEASE_ID"
ln -s "$FINAL" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT"
systemctl restart "$SERVICE"

healthy=false
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
    --header "Authorization: Bearer $HEALTHCHECK_TOKEN" \
    http://127.0.0.1:3457/api/health/ready >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" == true ]]; then
  echo "deployed $RELEASE_ID"
  exit 0
fi

echo "readiness failed for $RELEASE_ID; rolling code back" >&2
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  ROLLBACK_LINK="$BASE/.rollback-$RELEASE_ID"
  ln -s "$PREVIOUS" "$ROLLBACK_LINK"
  mv -Tf "$ROLLBACK_LINK" "$CURRENT"
  systemctl restart "$SERVICE"
  curl --fail --silent --show-error \
    --header "Authorization: Bearer $HEALTHCHECK_TOKEN" \
    http://127.0.0.1:3457/api/health/ready >/dev/null || true
  echo "current points back to $PREVIOUS; failed release retained at $FINAL" >&2
else
  systemctl stop "$SERVICE"
  echo "no previous release exists; service stopped and failed release retained at $FINAL" >&2
fi
exit 1
