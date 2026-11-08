#!/bin/sh
# Offsite backup: packs up the whole app folder (code, .env, plan.json and data/, including a
# safe copy of the database), encrypts it, and uploads it to a PRIVATE GitHub repository as a
# release. GitHub only ever sees the encrypted file. Keeps the newest $KEEP backups.
#
# Setup (once):
#   apt install age gh           # age encrypts, gh talks to GitHub
#   gh auth login
#   age-keygen -o ~/.config/family-planner-backup/key.txt      # SAVE this key somewhere safe,
#   age-keygen -y ~/.config/family-planner-backup/key.txt > ~/.config/family-planner-backup/recipient.txt
#   echo 'BACKUP_REPO=you/your-private-backup-repo' > ~/.config/family-planner-backup/config
#
# Run by cron (see the README's "Offsite backup"), or by hand:  sh tools/offsite-backup.sh
# Restoring: see docs/restore.md.
set -eu

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
CONF_DIR=${CONF_DIR:-$HOME/.config/family-planner-backup}
KEEP=${KEEP:-14}
[ -f "$CONF_DIR/config" ] && . "$CONF_DIR/config"
: "${BACKUP_REPO:?Set BACKUP_REPO in $CONF_DIR/config}"
RECIPIENT=$(cat "$CONF_DIR/recipient.txt")

STAMP=$(date +%Y-%m-%d_%H%M)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; rm -f "$APP_DIR/data/.backup-app.db"' EXIT

# A consistent copy of the database while the app keeps running (VACUUM INTO writes a clean copy).
if docker ps --format '{{.Names}}' | grep -qx shopping-list-api; then
  docker exec shopping-list-api node --disable-warning=ExperimentalWarning -e \
    "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/app.db');d.exec(\"VACUUM INTO '/data/.backup-app.db'\")"
fi

# Everything in the app folder. The live database files are swapped for the clean copy above.
NAME="family-planner-$STAMP"
tar -C "$(dirname "$APP_DIR")" -czf "$WORK/$NAME.tar.gz" \
  --exclude="$(basename "$APP_DIR")/data/app.db" \
  --exclude="$(basename "$APP_DIR")/data/app.db-wal" \
  --exclude="$(basename "$APP_DIR")/data/app.db-shm" \
  --transform "s|data/.backup-app.db\$|data/app.db|" \
  "$(basename "$APP_DIR")"

age -r "$RECIPIENT" -o "$WORK/$NAME.tar.gz.age" "$WORK/$NAME.tar.gz"
rm "$WORK/$NAME.tar.gz"
SIZE=$(du -h "$WORK/$NAME.tar.gz.age" | cut -f1)

gh release create "backup-$STAMP" "$WORK/$NAME.tar.gz.age" --repo "$BACKUP_REPO" \
  --title "Backup $STAMP" --notes "Encrypted backup of the whole app folder ($SIZE). See RESTORE.md." >/dev/null

# Keep the newest $KEEP backups.
gh release list --repo "$BACKUP_REPO" --limit 200 --json tagName,createdAt \
  --jq 'sort_by(.createdAt) | reverse | .[].tagName' | tail -n +"$((KEEP + 1))" |
  while read -r tag; do gh release delete "$tag" --repo "$BACKUP_REPO" --yes --cleanup-tag >/dev/null; done

echo "$(date '+%F %T') uploaded backup-$STAMP ($SIZE) to $BACKUP_REPO"
