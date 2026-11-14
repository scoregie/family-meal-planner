#!/bin/sh
# The page check: proves a change didn't alter what the pages do.
#
# It opens every page of the app in a pretend browser against a throwaway copy of the server,
# presses every button, tick box and fold in turn, and writes down what each page looked like
# after every press (tools/page-check.js does the work). Use it around a change that shouldn't
# alter what the app does, such as tidying code:
#
#   tools/page-check.sh record before          1. record the code as it is now
#   ...make your change...
#   tools/page-check.sh record after           2. record it again
#   tools/page-check.sh compare before after   3. "All 26 pages are the same", or what differs
#
# A recording takes a minute or two. To record only some pages, add part of their name:
#   tools/page-check.sh record after progress
#
# Your family's data is never touched: the throwaway server has its own empty data folder, the
# example plan and a made-up person. Recordings are kept in .page-check/ (not saved to git).
#
# It needs Docker, and the first run downloads a package called jsdom (the pretend browser) into
# .page-check/. It is only for this check: the app itself doesn't use it. What it can't see:
# layout, touch and drag and drop (it isn't a real browser), and anything that needs an AI key.
set -e
cd "$(dirname "$0")/.."
WORK="$PWD/.page-check"
mkdir -p "$WORK"

# Runs a command in a throwaway Node.js container, with the project (read only) and .page-check/.
run() {
  docker run --rm -v "$PWD":/repo:ro -v "$WORK":/work -w /work -e NODE_PATH=/work/node_modules node:22-alpine "$@"
}

case "$1" in
  record)
    [ -n "$2" ] || { echo "Give the recording a name, for example: tools/page-check.sh record before"; exit 2; }
    if [ ! -d "$WORK/node_modules/jsdom" ]; then
      echo "Downloading jsdom (first run only)…"
      run npm install jsdom@31.0.1 --prefix /work --no-audit --no-fund --loglevel=error
    fi
    run node --disable-warning=ExperimentalWarning /repo/tools/page-check.js record /repo "/work/$2" "$3"
    ;;
  compare)
    [ -d "$WORK/$2" ] && [ -d "$WORK/$3" ] || { echo "Record both first, for example: tools/page-check.sh record before"; exit 2; }
    run node /repo/tools/page-check.js compare "/work/$2" "/work/$3"
    ;;
  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
