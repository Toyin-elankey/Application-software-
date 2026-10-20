#!/usr/bin/env bash
# Checks that the committed baseline migration matches prisma/schema.prisma.
# Runs Prisma's own `migrate diff --exit-code` (exit 0 = no difference, 2 = difference, 1 = error).
# Without --exit-code Prisma exits 0 even when the schema and baseline differ, so the flag is required.
# On failure it also publishes the diff as a GitHub annotation, so the SQL can be read through the
# API even when job logs are not available.
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

tmp="$(mktemp -d)"
mkdir -p "$tmp/0001_baseline"
cp prisma/migrations/0001_baseline/migration.sql "$tmp/0001_baseline/"
cp prisma/migrations/migration_lock.toml "$tmp/"

npx prisma migrate diff \
  --from-migrations "$tmp" \
  --to-schema prisma/schema.prisma \
  --script --exit-code >"$tmp/drift.sql" 2>"$tmp/drift.err"
code=$?

echo "prisma migrate diff exit code: $code"
if [ "$code" -ne 0 ]; then
  echo "--- stderr (first 60 lines):"
  head -n 60 "$tmp/drift.err"
  echo "--- SQL that would reconcile the baseline with the schema (first 80 lines):"
  head -n 80 "$tmp/drift.sql"
  # Annotation: one message holding the start of stderr and the diff, newlines encoded for GitHub.
  payload="$( (head -c 1500 "$tmp/drift.err"; echo; echo "--- diff:"; head -c 2500 "$tmp/drift.sql") | sed ':a;N;$!ba;s/%/%25/g;s/\r/%0D/g;s/\n/%0A/g')"
  echo "::error title=Baseline drift (exit $code)::${payload}"
fi
exit "$code"
