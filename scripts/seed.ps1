# ---------------------------------------------------------------------------
# SYMBIOTIC CITY -- reset the demo data, or reseed it
#
#   .\scripts\seed.ps1                 # ask, then clear ALL data and reseed
#   .\scripts\seed.ps1 -Force          # no prompt
#   .\scripts\seed.ps1 -KeepRuns       # keep simulation/plan/workflow history
#
# Windows counterpart of scripts/seed.sh.
#
# It does NOT delete the database file. On Windows a file held open by the API
# cannot be deleted (EPERM / "being used by another process"), which made the
# obvious version of this script fail exactly when someone had the app running
# -- the normal time to want a reset. Instead it clears the tables through the
# same SQLAlchemy connection the app uses, so it works with the server running:
# stop the API only if you also want to reclaim the file.
#
# The file path is asked of the app's settings, so a custom DATABASE_URL in
# .env is honoured and no path is guessed.
#
# NOT executed by the author on real Windows: this environment has none. The
# Python half (the part that does the work) was run against a real database.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [switch]$Force,
    # Keep simulation runs, optimisation plans, workflows and their events.
    # Useful when you only want the catalogue (assets, zones, users) intact.
    [switch]$KeepRuns
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Windows puts the interpreter in .venv\Scripts, not .venv/bin.
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Python venv not found at .venv\Scripts\python.exe" -ForegroundColor Red
    Write-Host "Create it with:  .\scripts\dev.ps1 setup" -ForegroundColor Yellow
    exit 1
}

if (-not $Force) {
    Write-Host "This deletes all local data and reseeds the demo catalogue." -ForegroundColor Yellow
    Write-Host "The API may stay running."
    $reply = Read-Host "Continue? [y/N]"
    if ($reply -notmatch '^[Yy]$') {
        Write-Host "aborted"
        exit 1
    }
}

if ($KeepRuns) {
    $resetMode = "keep-runs"
} else {
    $resetMode = "all"
}

# The work is done in Python, through the app's own engine.
#
# Not `python -c "..."`: the source would have to be quoted inside PowerShell,
# and getting that wrong fails silently. Not a temp .py file either -- one in
# %TEMP% cannot `import app` (Python puts the *script's* directory on sys.path,
# not the working directory), and one inside backend\ could shadow the real
# `app` package. Piping to stdin is the form that keeps sys.path pointed at the
# current directory, which the push below makes backend\.
$seedCode = @'
import sys

from sqlalchemy import text

from app.core.config import settings
from app.core.database import Base, engine, session_scope
from app.seed.demo import seed_all

# Imported for the side effect of registering every table on Base.metadata.
import app.models  # noqa: F401

path = settings.sqlite_path
if path is None:
    print("DATABASE_URL is not a SQLite URL; refresh that database with its own tooling.")
    sys.exit(1)

mode = sys.argv[1] if len(sys.argv) > 1 else "all"

# Rows that belong to a user session or a previous exercise. Cleared first
# because the seeded catalogue is referenced *by* them.
RUN_TABLES = [
    "workflow_events",
    "workflow_instances",
    "repair_tasks",
    "task_status_history",
    "incident_assets",
    "incident_events",
    "resource_reservations",
    "optimization_assignments",
    "optimization_plans",
    "optimization_requests",
    "simulation_results",
    "simulation_runs",
    "simulation_scenarios",
    "whatif_observations",
    "whatif_scenarios",
    "infrastructure_status_history",
    "notifications",
    "audit_logs",
    "idempotency_keys",
    "password_reset_tokens",
    "sessions",
    "incidents",
]


def clear_all(connection) -> None:
    """Empty every table, in one transaction.

    SQLite enforces foreign keys, and several tables reference each other
    (incidents <-> optimisation plans <-> simulation runs), so there is no
    safe order to delete in. Turning the checks off for the duration of the
    transaction and deleting everything is the reliable way; the schema is
    untouched, so the seeder then repopulates it.
    """
    connection.execute(text("PRAGMA foreign_keys = OFF"))
    # Base.metadata.sorted_tables is deliberately not used: the same cycles make
    # it impossible to sort, and asking for it emits a warning.
    for table in Base.metadata.tables.values():
        connection.execute(table.delete())
    connection.execute(text("PRAGMA foreign_keys = ON"))


with engine.begin() as connection:
    if mode == "all":
        clear_all(connection)
    else:
        # Keep the catalogue; drop only this session's activity.
        connection.execute(text("PRAGMA foreign_keys = OFF"))
        for name in RUN_TABLES:
            if name in Base.metadata.tables:
                connection.execute(Base.metadata.tables[name].delete())
        connection.execute(text("PRAGMA foreign_keys = ON"))
        # The catalogue survives, so the seeder must not try to insert it again;
        # it is idempotent, so this only skips work it would have done anyway.

with session_scope() as db:
    print("seeded:", seed_all(db))

print("database ready:", path)
'@

Push-Location (Join-Path $Root "backend")
try {
    $seedCode | & $VenvPython - $resetMode
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
