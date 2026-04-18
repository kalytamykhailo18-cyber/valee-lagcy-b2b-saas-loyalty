#!/usr/bin/env bash
#
# Backup script for the Valee PostgreSQL database. Intended to be invoked by
# cron on a regular cadence (recommended: hourly). Produces a timestamped
# compressed dump in $BACKUP_DIR and prunes dumps older than $RETENTION_DAYS.
#
# Required env (loaded from .env):
#   DATABASE_URL       — Postgres connection string, used with pg_dump
#
# Optional env (override via cron or .env):
#   BACKUP_DIR         — destination directory (default /var/backups/valee)
#   RETENTION_DAYS     — local dumps to keep (default 7)
#   BACKUP_S3_BUCKET   — when set, sync dump to s3://$BACKUP_S3_BUCKET/
#                        (requires aws-cli configured). No-op if unset.
#
# Exit codes:
#   0 success, non-zero on failure. Cron should alert on non-zero via MAILTO
#   and/or a log watcher that ships to Sentry.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"

# Load .env if present (cron runs with a stripped environment).
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/valee}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$BACKUP_DIR/valee-$TIMESTAMP.sql.gz"

echo "[backup] dumping to $DUMP_FILE"
# --no-owner + --no-privileges keep the dump portable across environments.
# --format=plain + gzip is the simplest portable format. For very large DBs
# we'd switch to --format=custom for parallel restore, not needed at our size.
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "[backup] ok — $SIZE"

# Optional S3 sync if the bucket is configured.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    echo "[backup] syncing to s3://$BACKUP_S3_BUCKET/"
    aws s3 cp "$DUMP_FILE" "s3://$BACKUP_S3_BUCKET/$(basename "$DUMP_FILE")" \
      --storage-class STANDARD_IA --only-show-errors
  else
    echo "[backup] WARNING: BACKUP_S3_BUCKET set but aws-cli missing, skipping upload"
  fi
fi

# Prune old local dumps.
find "$BACKUP_DIR" -type f -name 'valee-*.sql.gz' -mtime +"$RETENTION_DAYS" -print -delete
echo "[backup] done"
