#!/usr/bin/env bash
#
# Back up the things that cannot be regenerated: config.json (bot token and
# API keys) and data/ (scan history, performance baselines, watch schedule).
# Cached API responses are skipped because they are rebuilt on demand.
#
# Usage:  scripts/backup.sh
# Cron:   0 3 * * * /home/ubuntu/meteora-smart-wallet-finder/scripts/backup.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/swf-backups}"
KEEP="${BACKUP_KEEP:-7}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$DEST/swf-$STAMP.tar.gz"

mkdir -p "$DEST"
chmod 700 "$DEST"

# Keep the archive unreadable to other users: it contains secrets.
umask 077

tar -czf "$ARCHIVE" \
  --exclude='data/cache' \
  -C "$ROOT" \
  config.json data

chmod 600 "$ARCHIVE"

# Retention: keep the newest $KEEP archives.
find "$DEST" -maxdepth 1 -name 'swf-*.tar.gz' -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n +"$((KEEP + 1))" \
  | cut -d' ' -f2- \
  | xargs -r rm -f

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup ok: $ARCHIVE ($SIZE)"
