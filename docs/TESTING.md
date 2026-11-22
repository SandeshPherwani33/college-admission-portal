# Testing

Run backend tests from an empty temporary working directory so settings cannot load a project `.env` file. Use explicit demo storage and mock AI providers; never point this suite at production data.

```powershell
$repo = (Get-Location).Path
$testDir = Join-Path ([System.IO.Path]::GetTempPath()) ("uniapply-pytest-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testDir | Out-Null
$env:PYTHONPATH = Join-Path $repo "backend"
$env:APP_ENV = "development"
$env:STORAGE_BACKEND = "demo"
$env:MONGODB_URI = ""
$env:LLM_PROVIDER = "demo"
Push-Location $testDir
try {
    python -m pytest -q -c (Join-Path $repo "backend\pytest.ini") (Join-Path $repo "backend\tests")
} finally {
    Pop-Location
    Remove-Item -LiteralPath $testDir -Recurse -Force
}
```

In `frontend`, run `npm run build` and `npm run test:logic`. The browser journey uses isolated loopback services and synthetic account data:

```powershell
$env:PYTHON = "<path-to-project-python.exe>"
npm run test:journey
```

In `mobile`, run `npx tsc --noEmit` and `npm run build`. Check locked JavaScript dependencies with `npm audit` in `frontend`, `mobile`, and `desktop`; check the active Python environment with `python -m pip check`. Audit declared backend dependencies with `python -m pip_audit -r backend\requirements.txt` from a working directory outside the project so project environment files are not loaded.

The browser journey covers the student workflows, application-data integrity, chatbot behavior, and 360px, 768px, and 1280px layouts. Its Ollama server is synthetic. The optional `RUN_OLLAMA_SMOKE=1` test contacts only the configured loopback Ollama server and requires the selected model to be installed. Mocked Mongo tests do not replace verification against an authorized transaction-capable MongoDB deployment.
