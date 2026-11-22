#!/usr/bin/env bash
# Reset the database to a freshly seeded demo state.
#
#   ./scripts/seed.sh          # SQLite dev database (backend/data/symbiotic_city.db)
#   FORCE=1 ./scripts/seed.sh  # skip the confirmation prompt
#
# The seeder is idempotent, but a hard reset guarantees stable ids for the
# fixtures the demo and the smoke script reference (assets 1..23,
# one active incident, one approval-ready plan).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"

# The database lives wherever DATABASE_URL points (backend/data/... by default),
# so ask the app settings rather than hardcoding a path.
DB_FILE="$(cd "$ROOT/backend" && "$PYTHON" -c 'from app.core.config import settings; print(settings.sqlite_path or "")')"
if [[ -z "$DB_FILE" ]]; then
  echo "DATABASE_URL is not a SQLite URL; refresh that database with its own tooling." >&2
  exit 1
fi

if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "This deletes $DB_FILE and reseeds it. Continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted"; exit 1; }
fi

rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"
cd "$ROOT/backend"
"$PYTHON" - <<'PY'
from app.core.database import Base, engine, session_scope
from app.seed.demo import seed_all

Base.metadata.create_all(engine)
with session_scope() as db:
    print("seeded:", seed_all(db))
PY
echo "database ready: $DB_FILE"
