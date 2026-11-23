#!/usr/bin/env bash
# One-command verification of the whole repository.
#
#   ./scripts/verify.sh          # backend tests + frontend typecheck + build
#   ./scripts/verify.sh backend  # backend only
#   ./scripts/verify.sh frontend # frontend only
#   ./scripts/verify.sh postgres # migration + parity suite against PostgreSQL
#
# Uses a throwaway SQLite database so it never touches data/dev.db.
#
# The postgres target needs POSTGRES_TEST_URL, e.g.
#   POSTGRES_TEST_URL=postgresql+psycopg2://postgres@/symbiotic_test ./scripts/verify.sh postgres
# It exists because the migration was broken on PostgreSQL while every SQLite
# check stayed green — SQLite does not validate foreign keys at DDL time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
TARGET="${1:-all}"

run_backend() {
  echo "── backend: migrations up/down + pytest (SQLite)"
  cd "$ROOT/backend"
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m alembic upgrade head >/dev/null
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m alembic downgrade base >/dev/null
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m pytest tests -q
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
}

run_postgres() {
  if [[ -z "${POSTGRES_TEST_URL:-}" ]]; then
    echo "POSTGRES_TEST_URL is not set — see the header of this script." >&2
    exit 2
  fi
  echo "── backend: migrations up/down/up + parity suite (PostgreSQL)"
  cd "$ROOT/backend"
  PYTHONPATH=. DATABASE_URL="$POSTGRES_TEST_URL" "$PYTHON" -m alembic upgrade head
  PYTHONPATH=. DATABASE_URL="$POSTGRES_TEST_URL" "$PYTHON" -m alembic downgrade base
  PYTHONPATH=. DATABASE_URL="$POSTGRES_TEST_URL" "$PYTHON" -m alembic upgrade head
  POSTGRES_TEST_URL="$POSTGRES_TEST_URL" \
    "$PYTHON" -m pytest tests/test_migrations.py tests/test_postgres_parity.py -q
}

run_frontend() {
  echo "── frontend: typecheck + production build"
  cd "$ROOT/frontend"
  npx tsc --noEmit
  npm run build
}

case "$TARGET" in
  backend) run_backend ;;
  postgres) run_postgres ;;
  frontend) run_frontend ;;
  all) run_backend; run_frontend ;;
  *) echo "usage: $0 [all|backend|postgres|frontend]" >&2; exit 2 ;;
esac

echo "✓ all checks passed"
