#!/usr/bin/env bash
# Release gate: build, unit + bundle tests, mutation check, then every live scenario against a
# stock RisuAI web build (STOCK_DIR) and, unless SKIP_HOSTED_SITE=1, one reset on risuai.xyz.
# Needs PLAYWRIGHT_MODULE (see README.md in this folder). The tree is frozen after the build:
# any edit to src/, dist/, tests/ or scripts/ during the run stops the gate (venue-guard.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${STOCK_DIR:?set STOCK_DIR to a built stock RisuAI dist/ folder}"
source tests/live/venue-guard.sh
npm run build
venue_freeze
step npm test
step npm run mutate
step node tests/live/drive.mjs healthy console
step node tests/live/drive.mjs reset bookmarklet
step node tests/live/drive.mjs reset-race bookmarklet
step node tests/live/drive.mjs recover bookmarklet
step node tests/live/drive.mjs recover-account-hint bookmarklet
step node tests/live/drive.mjs not-settled bookmarklet
step node tests/live/drive.mjs receipt-stuck bookmarklet
step node tests/live/drive.mjs opfs-db bookmarklet
step node tests/live/drive.mjs aged-restore bookmarklet
step node tests/live/drive.mjs aged-reset console
LOCAL_CONSOLE=1 step node tests/live/drive.mjs reset loader
if [ "${SKIP_HOSTED_SITE:-0}" != "1" ]; then
  BASE_URL=https://risuai.xyz/ LOCAL_CONSOLE=1 step node tests/live/drive.mjs reset loader
  # Account mode runs on the official site with the TEST account (RPF_ACCOUNT_ENV; see account-live.mjs).
  for account_scenario in account-recover account-reset account-reset-rejected account-unavailable account-login account-local-only; do
    BASE_URL=https://risuai.xyz/ step node tests/live/drive.mjs "$account_scenario" bookmarklet
  done
fi
echo "run-all: every step passed"
