#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${1:-}"

if [[ -z "$OUTPUT" ]]; then
  echo "usage: $0 /absolute/path/pheno-lab-<release-id>.tar.gz" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "release artifacts must be built on Linux, matching the production host" >&2
  exit 2
fi
if [[ "${OUTPUT:0:1}" != "/" ]]; then
  echo "output path must be absolute" >&2
  exit 2
fi
if [[ -e "$OUTPUT" ]]; then
  echo "refusing to overwrite existing artifact: $OUTPUT" >&2
  exit 2
fi
if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "24" ]]; then
  echo "Node.js 24 is required to build the production artifact" >&2
  exit 2
fi

cd "$APP_DIR"
pnpm install --frozen-lockfile
# A frozen install is a no-op when the lockfile has not changed, and pnpm then
# skips Prisma's postinstall hook. On a long-lived build host that leaves a
# client generated from an older schema, so the first release carrying a
# migration fails typecheck against a stale client. Regenerate explicitly.
pnpm exec prisma generate
pnpm run verify

STAGING="$(mktemp -d)"
trap 'rm -rf -- "$STAGING"' EXIT
mkdir -p "$STAGING/pheno-lab"
cp -a \
  .next \
  public \
  node_modules \
  prisma \
  scripts \
  src \
  package.json \
  pnpm-lock.yaml \
  next.config.ts \
  .node-version \
  "$STAGING/pheno-lab/"

mkdir -p "$(dirname "$OUTPUT")"
tar --numeric-owner -C "$STAGING" -czf "$OUTPUT" pheno-lab
(
  cd "$(dirname "$OUTPUT")"
  sha256sum "$(basename "$OUTPUT")" > "$(basename "$OUTPUT").sha256"
)
echo "release artifact: $OUTPUT"
