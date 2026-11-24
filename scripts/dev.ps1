# ---------------------------------------------------------------------------
# SYMBIOTIC CITY — Windows / PowerShell development runner
#
#   .\scripts\dev.ps1            # both, API on :8000 and console on :3000
#   .\scripts\dev.ps1 api        # API only
#   .\scripts\dev.ps1 web        # console only
#   .\scripts\dev.ps1 setup      # create the venv and install both sides
#
# Replaces scripts/dev.sh, which is bash and cannot run in PowerShell.
#
# If PowerShell refuses to run this file with a "running scripts is disabled"
# error, that is the default execution policy, not a problem with the script.
# Either run it once per session as:
#     powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
# or unblock the current user permanently (a normal thing to do on a dev box):
#     Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#
# NOT executed by the author: this sandbox has no Windows or PowerShell. It is
# written from the same logic as dev.sh, but treat it as unverified until you
# have run it once.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("all", "api", "web", "setup")]
    [string]$Target = "all"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Windows puts the interpreter in .venv\Scripts, not .venv/bin.
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$Frontend = Join-Path $Root "frontend"

function Test-Venv {
    if (-not (Test-Path $VenvPython)) {
        Write-Host "Python venv not found at .venv\Scripts\python.exe" -ForegroundColor Red
        Write-Host "Create it with:" -ForegroundColor Yellow
        Write-Host "    .\scripts\dev.ps1 setup"
        Write-Host "or, by hand:"
        Write-Host "    python -m venv .venv"
        Write-Host "    .\.venv\Scripts\Activate.ps1"
        Write-Host "    pip install -r backend\requirements.txt"
        exit 1
    }
}

function Test-NodeModules {
    if (-not (Test-Path (Join-Path $Frontend "node_modules"))) {
        Write-Host "frontend\node_modules is missing. Run:" -ForegroundColor Red
        Write-Host "    cd frontend; npm install; cd .."
        exit 1
    }
}

switch ($Target) {
    "setup" {
        Write-Host "-> creating .venv with python" -ForegroundColor Cyan
        # 'python' rather than 'python3': the Windows launcher and python.org
        # installs do not ship a python3.exe, and the Microsoft Store stub that
        # does exist opens the Store instead of running.
        python -m venv .venv
        if ($LASTEXITCODE -ne 0) {
            Write-Host "python -m venv failed. Is Python 3.11+ installed and on PATH?" -ForegroundColor Red
            exit 1
        }

        Write-Host "-> installing backend requirements" -ForegroundColor Cyan
        & $VenvPython -m pip install --upgrade pip
        & $VenvPython -m pip install -r backend\requirements.txt
        if ($LASTEXITCODE -ne 0) { exit 1 }

        Write-Host "-> installing frontend packages (this takes a minute)" -ForegroundColor Cyan
        Push-Location $Frontend
        try {
            npm install
            if ($LASTEXITCODE -ne 0) { exit 1 }
        }
        finally {
            Pop-Location
        }

        Write-Host ""
        Write-Host "Setup complete. Start it with:" -ForegroundColor Green
        Write-Host "    .\scripts\dev.ps1"
    }

    "api" {
        Test-Venv
        Write-Host "-> API   http://127.0.0.1:8000/api  (docs at /api/docs)" -ForegroundColor Cyan
        Push-Location (Join-Path $Root "backend")
        try { & $VenvPython run.py } finally { Pop-Location }
    }

    "web" {
        Test-NodeModules
        Write-Host "-> Web   http://127.0.0.1:3000" -ForegroundColor Cyan
        Push-Location $Frontend
        try {
            # -H 0.0.0.0 so a phone on the same network can also reach it.
            npx next dev -p 3000 -H 0.0.0.0
        }
        finally { Pop-Location }
    }

    "all" {
        Test-Venv
        Test-NodeModules

        Write-Host "-> API   http://127.0.0.1:8000/api  (docs at /api/docs)" -ForegroundColor Cyan
        Write-Host "-> Web   http://127.0.0.1:3000" -ForegroundColor Cyan
        Write-Host "   Ctrl+C stops both." -ForegroundColor DarkGray
        Write-Host ""

        # Start-Process rather than a job, so the child servers get their own
        # consoles and Ctrl+C reaches them the way a user expects.
        $api = Start-Process -PassThru -NoNewWindow -WorkingDirectory (Join-Path $Root "backend") `
            -FilePath $VenvPython -ArgumentList "run.py"

        $web = Start-Process -PassThru -NoNewWindow -WorkingDirectory $Frontend `
            -FilePath "npx.cmd" -ArgumentList "next","dev","-p","3000","-H","0.0.0.0"

        try {
            Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor DarkGray
            # Wait for either to exit, then clean up the other.
            while (-not $api.HasExited -and -not $web.HasExited) {
                Start-Sleep -Milliseconds 500
            }
        }
        finally {
            foreach ($proc in @($api, $web)) {
                if ($proc -and -not $proc.HasExited) {
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}
