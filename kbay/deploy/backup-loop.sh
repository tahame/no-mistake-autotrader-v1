#!/bin/sh
# Runs inside the backup container: one dump per day at BACKUP_AT_UTC_HOUR (22 UTC = 3am PKT),
# plus one at start-up, then deletes dumps older than BACKUP_KEEP_DAYS.
set -eu
dump() {
  f="/backups/kbay-$(date -u +%Y%m%d-%H%M%S).sql.gz"
  pg_dump --no-owner --format=plain | gzip -9 > "$f.tmp" && mv "$f.tmp" "$f"
  echo "backup written: $f ($(du -h "$f" | cut -f1))"
  find /backups -name 'kbay-*.sql.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete
}
dump
last=$(date -u +%Y%m%d)
while true; do
  sleep 600
  if [ "$(date -u +%H)" -ge "$BACKUP_AT_UTC_HOUR" ] && [ "$(date -u +%Y%m%d)" != "$last" ]; then
    dump && last=$(date -u +%Y%m%d)
  fi
done
