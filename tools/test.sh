#!/bin/sh
# Runs the automated tests in tests/ (see tests/README.md).
#
# The tests run in a throwaway Node.js container, so you don't need Node installed. They start
# their own copy of the server in a temporary folder: your family's data is never touched.
#
# Usage (from the project folder):
#   tools/test.sh                 run every test
#   tools/test.sh tests/names.test.js   run one file
set -e
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then set -- "tests/*.test.js"; fi
exec docker run --rm -v "$PWD":/repo:ro -w /repo node:22-alpine \
  node --disable-warning=ExperimentalWarning --test --test-reporter=spec "$@"
