#!/usr/bin/env bash
# Reset the database to a freshly seeded demo state.
#
#   ./scripts/seed.sh          # SQLite dev database (data/symbiotic_city.db)
#   FORCE=1 ./scripts/seed.sh  # skip the confirmation prompt
#
# The seeder is idempotent, but a hard reset guarantees stable ids for the
# fixtures the demo and the Playwright specs reference (assets 1..24,
# one active incident, one approval-ready plan).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
DB_FILE="$ROOT/data/symbiotic_city.db"

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
