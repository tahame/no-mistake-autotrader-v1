#!/usr/bin/env bash
# Restore a backup into the K-BAY database:  ./restore.sh backups/kbay-YYYYMMDD-HHMMSS.sql.gz
# This REPLACES the current data. The app is stopped during the restore.
set -euo pipefail
cd "$(dirname "$0")"
f="${1:?usage: ./restore.sh backups/<file>.sql.gz}"
[ -f "$f" ] || { echo "No such file: $f"; exit 1; }
read -r -p "Replace ALL current K-BAY data with $f? Type RESTORE to continue: " ans
[ "$ans" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
set -a; . ./.env; set +a
docker compose stop app
docker compose exec -T db psql -U kbay_owner -d postgres -c "drop database if exists kbay with (force)" -c "create database kbay owner kbay_owner"
gunzip -c "$f" | docker compose exec -T db psql -U kbay_owner -d kbay -v ON_ERROR_STOP=1 >/dev/null
docker compose up -d app
echo "Restored from $f."
