#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
exec npx tsx scripts/ledger-audit.ts "$@"
