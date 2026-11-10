#!/bin/sh
# Shares new meals, snacks and exercises with every family using the app: adds them to
# api/library-community.json (version + 1) and opens a pull request. Families' servers download
# that file every 2 weeks once the pull request is merged.
#
#   tools/library-pr.sh                  the additions this server's admins approved on Plan setup
#                                        (data/library-additions.json)
#   tools/library-pr.sh <file.json>      any file shaped {dishes, snacks, exercises}
#   DRY_RUN=1 tools/library-pr.sh         show what it would do, without pushing
#
# Run it on the server from the project folder. It works in a separate checkout of main, so the
# running app's files are never touched. Needs git and the GitHub CLI (gh) logged in.
# Every 2 weeks from cron, for example:  0 9 1,15 * * cd /path/to/project && tools/library-pr.sh >> data/library-pr.log 2>&1
set -e
cd "$(dirname "$0")/.."
SRC="${1:-data/library-additions.json}"
[ -f "$SRC" ] || { echo "Nothing to share: $SRC doesn't exist yet."; exit 0; }

ROOT="$(pwd)"
WORK="$(mktemp -d)"
BRANCH=""
cleanup() {
  git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  # A dry run leaves no branch behind.
  if [ -n "$DRY_RUN" ] && [ -n "$BRANCH" ]; then git -C "$ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
git fetch -q origin main
git worktree add -q --detach "$WORK" origin/main

# Add anything new (by dish name, snack description or exercise id), and bump the version.
COUNT="$(python3 - "$SRC" "$WORK/api/library-community.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
new = json.load(open(src))
try:
    com = json.load(open(dst))
except FileNotFoundError:
    com = {'version': 0, 'dishes': [], 'snacks': [], 'exercises': []}
import re
# An exercise's id, worked out from its name the same way the app does (entries may not have one).
def exercise_id(e):
    return e.get('id') or re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', e['name'].lower()))
keys = {'dishes': lambda d: d['name'].lower(), 'snacks': lambda s: s['what'].lower(), 'exercises': exercise_id}
added = 0
for kind, key in keys.items():
    have = {key(x) for x in com.get(kind, [])}
    for item in new.get(kind, []):
        try:
            k = key(item)
        except (KeyError, AttributeError):
            continue
        if k in have:
            continue
        # Only what the library needs; the app works out macros, groups, tags and cost again anyway.
        com.setdefault(kind, []).append(item)
        have.add(k)
        added += 1
if added:
    com['version'] = int(com.get('version', 0)) + 1
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(com, f, indent=1, ensure_ascii=False)
        f.write('\n')
print(added)
PY
)"
if [ "$COUNT" = "0" ]; then
  echo "Nothing new to share."
  exit 0
fi

DATE="$(date +%Y-%m-%d)"
BRANCH="library-$DATE-$(date +%H%M)"
cd "$WORK"
git checkout -q -b "$BRANCH"
git add api/library-community.json
git commit -q -m "Library: $COUNT new meals, snacks or exercises ($DATE)"
if [ -n "$DRY_RUN" ]; then
  echo "Dry run: would open a pull request adding $COUNT."
  git show --stat --format='%s' HEAD
  exit 0
fi
git push -q -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "Library: $COUNT new meals, snacks or exercises ($DATE)" --body "New entries for the built-in plan builder's shared library (\`api/library-community.json\`). Every family's server checks them again when it downloads them, and works out nutrition, allergens and cost from the ingredients. Read the recipes and exercises before merging.

Made by tools/library-pr.sh."
