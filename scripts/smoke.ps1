# ---------------------------------------------------------------------------
# SYMBIOTIC CITY -- run the smoke check against a running API
#
#   .\scripts\smoke.ps1                          # expects the API on :8000
#   .\scripts\smoke.ps1 -ApiUrl http://127.0.0.1:8011/api
#
# Start the stack first (.\scripts\dev.ps1) in another terminal, then run this.
# Windows counterpart of `python scripts/smoke.py`, which works here too -- this
# only exists so the venv path does not have to be typed out.
#
# NOT executed by the author: this sandbox has no Windows or PowerShell.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    # smoke.py takes the full API base (including /api) as its first argument.
    [string]$ApiUrl
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

$smoke = Join-Path $Root "scripts\smoke.py"
$arguments = @($smoke)
if ($ApiUrl) {
    $arguments += $ApiUrl
}

& $VenvPython @arguments
exit $LASTEXITCODE
