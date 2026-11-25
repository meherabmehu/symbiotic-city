# ---------------------------------------------------------------------------
# SYMBIOTIC CITY -- reset the SQLite database to a freshly seeded demo state
#
#   .\scripts\seed.ps1                 # asks before deleting anything
#   .\scripts\seed.ps1 -Force          # no prompt
#   .\scripts\seed.ps1 -DbFile C:\x.db # override the file to delete
#
# Windows counterpart of scripts/seed.sh, which is bash and cannot run here.
# It asks the backend's settings where the database actually is, so a custom
# DATABASE_URL in .env is respected -- the file is never guessed.
#
# NOT executed by the author: this sandbox has no Windows or PowerShell. It is
# written from the same logic as seed.sh; treat it as unverified until you have
# run it once.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$DbFile
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Windows puts the interpreter in .venv\Scripts, not .venv/bin.
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "Python venv not found at .venv\Scripts\python.exe" -ForegroundColor Red
    Write-Host "Create it with:" -ForegroundColor Yellow
    Write-Host "    .\scripts\dev.ps1 setup"
    exit 1
}

# Ask the app where the database is, rather than assuming a path. The answer
# honours DATABASE_URL, and it is absolute regardless of the current directory.
if (-not $DbFile) {
    Push-Location (Join-Path $Root "backend")
    try {
        $DbFile = & $VenvPython -c "from app.core.config import settings; print(settings.sqlite_path or '')"
    }
    finally {
        Pop-Location
    }
}

if (-not $DbFile) {
    Write-Host "DATABASE_URL is not a SQLite URL; refresh that database with its own tooling." -ForegroundColor Red
    exit 1
}

if (-not $Force) {
    $reply = Read-Host "This deletes $DbFile and reseeds it. Continue? [y/N]"
    if ($reply -notmatch '^[Yy]$') {
        Write-Host "aborted"
        exit 1
    }
}

# The -wal and -shm files belong to the same database. Leaving them behind can
# resurrect rows that were just deleted.
foreach ($suffix in @("", "-wal", "-shm")) {
    $path = "$DbFile$suffix"
    if (Test-Path $path) {
        Remove-Item -Force $path
    }
}

# The seeding code is piped to the interpreter on stdin rather than passed as
# `python -c "..."` or written to a temp file.
#
#  - `-c` would need the Python source quoted inside PowerShell, and getting
#    that wrong is silent and confusing.
#  - A temp .py file in %TEMP% cannot import `app`, because Python puts the
#    *script's* directory on sys.path, not the current directory. Put it in
#    backend\ instead and a file there could shadow the real `app` package.
#  - stdin runs with an empty sys.path entry, which resolves to the current
#    directory -- and the push below makes that backend\.
#
# The same seeder the API runs on first boot, so ids match what the demo and
# the smoke script expect (assets 1..23, one active incident, ...).
$seedCode = @'
from app.core.database import Base, engine, session_scope
from app.seed.demo import seed_all

Base.metadata.create_all(engine)
with session_scope() as db:
    print("seeded:", seed_all(db))
'@

Push-Location (Join-Path $Root "backend")
try {
    $seedCode | & $VenvPython -
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}

Write-Host "database ready: $DbFile" -ForegroundColor Green
