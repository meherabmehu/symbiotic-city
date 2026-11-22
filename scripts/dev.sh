#!/usr/bin/env bash
# Run the API and the web console together for local development.
#
#   ./scripts/dev.sh            # both, with logs interleaved
#   ./scripts/dev.sh api        # only the FastAPI server on :8000
#   ./scripts/dev.sh web        # only the Next.js server on :3000
#
# Requires the Python venv at .venv (see docs/SETUP.md) and frontend/node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
TARGET="${1:-all}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Python venv not found at $PYTHON" >&2
  echo "Create it with:  python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt" >&2
  exit 1
fi

start_api() {
  echo "→ API   http://127.0.0.1:8000/api  (docs at /api/docs)"
  ( cd "$ROOT/backend" && exec "$PYTHON" run.py )
}

start_web() {
  if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
    echo "frontend/node_modules is missing; run: cd frontend && npm install" >&2
    exit 1
  fi
  echo "→ Web   http://127.0.0.1:3000"
  ( cd "$ROOT/frontend" && exec npx next dev -p 3000 -H 0.0.0.0 )
}

case "$TARGET" in
  api) start_api ;;
  web) start_web ;;
  all)
    trap 'kill 0' EXIT INT TERM
    start_api &
    start_web &
    wait -n
    ;;
  *)
    echo "usage: $0 [all|api|web]" >&2
    exit 2
    ;;
esac
