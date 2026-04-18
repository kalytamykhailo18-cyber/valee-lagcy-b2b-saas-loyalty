#!/usr/bin/env bash
# Entry-point wrapper for the smoke suite. Use this from cron / CI / post-deploy.
# Exit 0 = all flows passed. Non-zero = regression detected; Sentry will also
# receive any backend error surfaced during the run.

set -eu
cd "$(dirname "$0")/.."
exec npx tsx scripts/smoke.ts "$@"
