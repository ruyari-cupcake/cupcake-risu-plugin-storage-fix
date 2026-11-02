#!/usr/bin/env bash
# Release gate: build, unit + bundle tests, mutation check, then every live scenario against a
# stock RisuAI web build (STOCK_DIR) and, unless SKIP_HOSTED_SITE=1, one reset on risuai.xyz.
# Needs PLAYWRIGHT_MODULE (see README.md in this folder).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${STOCK_DIR:?set STOCK_DIR to a built stock RisuAI dist/ folder}"
npm run build
npm test
npm run mutate
node tests/live/drive.mjs healthy console
node tests/live/drive.mjs account console
node tests/live/drive.mjs reset bookmarklet
node tests/live/drive.mjs reset-race bookmarklet
node tests/live/drive.mjs recover bookmarklet
node tests/live/drive.mjs opfs-db bookmarklet
LOCAL_CONSOLE=1 node tests/live/drive.mjs reset loader
if [ "${SKIP_HOSTED_SITE:-0}" != "1" ]; then
  BASE_URL=https://risuai.xyz/ LOCAL_CONSOLE=1 node tests/live/drive.mjs reset loader
fi
echo "run-all: every step passed"
