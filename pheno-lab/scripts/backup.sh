#!/bin/bash
# Nightly PostgreSQL backup for the Pheno Lab Data Platform.
# Dumps to BACKUP_DIR/pheno_lab-YYYYmmdd-HHMMSS.sql.gz and keeps the last 30.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
: "${DATABASE_URL:?DATABASE_URL must be provided by the service environment}"
mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/pheno_lab-$STAMP.sql.gz"

TMP="$OUT.tmp"
trap 'rm -f "$TMP"' EXIT
"$PG_DUMP_BIN" "$DATABASE_URL" | gzip > "$TMP"
mv "$TMP" "$OUT"
trap - EXIT

# Rotate: keep the newest 30 backups.
shopt -s nullglob
backups=("$BACKUP_DIR"/pheno_lab-*.sql.gz)
if (( ${#backups[@]} > 30 )); then
  while IFS= read -r old; do
    rm -f -- "$old"
  done < <(ls -1t "${backups[@]}" | tail -n +31)
fi

echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
