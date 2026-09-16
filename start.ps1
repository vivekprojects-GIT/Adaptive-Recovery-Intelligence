# Adaptive Recovery Intelligence (ARI) - start both services.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$venvPython = Join-Path $root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Creating backend virtualenv..." -ForegroundColor Cyan
    python -m venv (Join-Path $root "backend\.venv")
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r (Join-Path $root "backend\requirements.txt")
}

if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
    Write-Host "Installing frontend packages..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend"); npm install; Pop-Location
}

Write-Host "Starting API on http://localhost:8000" -ForegroundColor Green
Start-Process -FilePath $venvPython `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--reload", "--port", "8000" `
    -WorkingDirectory (Join-Path $root "backend")

Write-Host "Starting UI  on http://localhost:5173" -ForegroundColor Green
Start-Process -FilePath "npm" -ArgumentList "run", "dev" `
    -WorkingDirectory (Join-Path $root "frontend")

Write-Host "`nARI is starting. Open http://localhost:5173" -ForegroundColor Yellow
