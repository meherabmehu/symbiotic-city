#!/usr/bin/env bash
# One-command verification of the whole repository.
#
#   ./scripts/verify.sh          # backend tests + frontend typecheck + build
#   ./scripts/verify.sh backend  # backend only
#   ./scripts/verify.sh frontend # frontend only
#
# Uses a throwaway SQLite database so it never touches data/dev.db.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
TARGET="${1:-all}"

run_backend() {
  echo "── backend: migrations up/down + pytest"
  cd "$ROOT/backend"
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m alembic upgrade head >/dev/null
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m alembic downgrade base >/dev/null
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
  DATABASE_URL="sqlite:////tmp/symbiotic_verify.db" "$PYTHON" -m pytest tests -q
  rm -f /tmp/symbiotic_verify.db /tmp/symbiotic_verify.db-*
}

run_frontend() {
  echo "── frontend: typecheck + production build"
  cd "$ROOT/frontend"
  npx tsc --noEmit
  npm run build
}

case "$TARGET" in
  backend) run_backend ;;
  frontend) run_frontend ;;
  all) run_backend; run_frontend ;;
  *) echo "usage: $0 [all|backend|frontend]" >&2; exit 2 ;;
esac

echo "✓ all checks passed"
