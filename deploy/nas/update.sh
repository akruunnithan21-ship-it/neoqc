#!/usr/bin/env bash
# Keeps the NAS copy of the website in step with GitHub main (the dashboard/
# folder of akruunnithan21-ship-it/neoqc). Run every 5 minutes by
# neo-tracker-update.timer; safe to run by hand: `~/neo-tracker/update.sh`.
#
# - Takes only dashboard/ and deploy/nas/ (sparse, shallow clone in ./repo).
# - Swaps the new site in with one rename, so a visitor never sees half a site.
# - When server.js itself changed, copies it and stops the server process;
#   systemd (Restart=always) starts it again on the new code.
# - Does nothing when main hasn't moved.
set -euo pipefail

DIR="${NEO_TRACKER_DIR:-/home/neo_tokyo/neo-tracker}"
REPO="$DIR/repo"
URL="https://github.com/akruunnithan21-ship-it/neoqc.git"

if [ ! -d "$REPO/.git" ]; then
  git clone --quiet --depth 1 --branch main --filter=blob:none --sparse "$URL" "$REPO"
  git -C "$REPO" sparse-checkout set dashboard deploy/nas
fi

git -C "$REPO" fetch --quiet --depth 1 origin main
NEW="$(git -C "$REPO" rev-parse FETCH_HEAD)"
OLD="$(cat "$DIR/.deployed" 2>/dev/null || true)"
[ "$NEW" = "$OLD" ] && exit 0

git -C "$REPO" reset --quiet --hard FETCH_HEAD
[ -f "$REPO/dashboard/index.html" ] || { echo "update: no dashboard/index.html at $NEW, keeping the current site" >&2; exit 1; }

rm -rf "$DIR/site.new"
cp -a "$REPO/dashboard" "$DIR/site.new"
echo "tracker $(git -C "$REPO" rev-parse --short HEAD) $(date -Is)" > "$DIR/site.new/VERSION.txt"
rm -rf "$DIR/site.old"
[ -d "$DIR/site" ] && mv "$DIR/site" "$DIR/site.old"
mv "$DIR/site.new" "$DIR/site"

if ! cmp -s "$REPO/deploy/nas/server.js" "$DIR/server.js"; then
  cp "$REPO/deploy/nas/server.js" "$DIR/server.js"
  pkill -TERM -u "$(id -u)" -f "$DIR/server.js" || true
  echo "update: server.js changed, the server restarts on the new code"
fi
cp "$REPO/deploy/nas/update.sh" "$DIR/update.sh.next" && chmod +x "$DIR/update.sh.next" && mv "$DIR/update.sh.next" "$DIR/update.sh"

echo "$NEW" > "$DIR/.deployed"
echo "update: now serving $(git -C "$REPO" rev-parse --short HEAD)"
