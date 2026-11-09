#!/bin/sh
# Draft the family's 4-week plan in a Claude Code session (on a Claude subscription) instead of
# the app's AI (which needs an API key). See "Drafting the plan with Claude Code" in the README.
#
#   tools/claude-code-plan.sh prompt ["a note"]   -> data/claude-code/prompt.md (instructions + About me answers)
#   tools/claude-code-plan.sh submit [file]       -> sends data/claude-code/plan.json to Plan setup for approval
#
# Run it from the project folder on the server, while the app is running.
set -e
cd "$(dirname "$0")/.."
exec docker exec -e DATA_DIR=/data shopping-list-api sh -c 'cd /app && NODE_PATH=/deps/node_modules exec node --no-warnings handoff-cli.js "$@"' sh "$@"
