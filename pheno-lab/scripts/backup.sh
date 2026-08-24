#!/bin/bash
# Nightly PostgreSQL backup for the Pheno Lab Data Platform.
# Dumps to backups/pheno_lab-YYYYmmdd-HHMMSS.sql.gz and keeps the last 30.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"

# Read DATABASE_URL from .env
DATABASE_URL=$(grep '^DATABASE_URL=' "$APP_DIR/.env" | cut -d'"' -f2)

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/pheno_lab-$STAMP.sql.gz"

PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
pg_dump "$DATABASE_URL" | gzip > "$OUT"

# Rotate: keep the newest 30 backups.
ls -1t "$BACKUP_DIR"/pheno_lab-*.sql.gz 2>/dev/null | tail -n +31 | xargs -I{} rm -f {}

echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
