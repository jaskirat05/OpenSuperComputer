$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $root ".runtime"
$nodeDir = Join-Path $runtimeDir "node24"
$nodeExe = Join-Path $nodeDir "node.exe"
$nodeVersion = "24"
$serviceDir = Join-Path $root "comfy_service"
$serviceEnv = Join-Path $serviceDir ".env"
$uvBinDir = Join-Path $HOME ".local\bin"

function Get-NodeMajor([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $version = (& $path --version).Trim()
  if ($version -notmatch '^v(\d+)\.') { return 0 }
  return [int]$Matches[1]
}

Write-Host "Open SuperComputer setup" -ForegroundColor Cyan
Write-Host "This installs the app runtimes and the local Comfy MCP bridge. It does not install ComfyUI."

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if ((Get-NodeMajor $nodeExe) -ne [int]$nodeVersion) {
  Write-Host "Finding the latest Node.js $nodeVersion LTS release..."
  $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $release = $releases | Where-Object { $_.version -match '^v24\.' -and $_.lts } | Select-Object -First 1
  if (-not $release) { throw "Could not find a Node.js 24 LTS release from nodejs.org." }

  $archiveName = "node-$($release.version)-win-x64.zip"
  $releaseUrl = "https://nodejs.org/dist/$($release.version)"
  $archivePath = Join-Path $runtimeDir $archiveName
  $checksumPath = Join-Path $runtimeDir "SHASUMS256.txt"
  $extractDir = Join-Path $runtimeDir "node-extract"

  Write-Host "Downloading $archiveName..."
  Invoke-WebRequest -Uri "$releaseUrl/$archiveName" -OutFile $archivePath
  Invoke-WebRequest -Uri "$releaseUrl/SHASUMS256.txt" -OutFile $checksumPath
  $checksumLine = Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" } | Select-Object -First 1
  if (-not $checksumLine -or $checksumLine -notmatch '^([a-fA-F0-9]{64})\s+') { throw "Could not verify the Node.js archive checksum." }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Node.js archive checksum verification failed." }

  Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $extractedNodeDir = Join-Path $extractDir "node-$($release.version)-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $extractedNodeDir "node.exe"))) { throw "The Node.js archive did not contain node.exe." }
  Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $extractedNodeDir -Destination $nodeDir
  Remove-Item -LiteralPath $extractDir -Recurse -Force
  Remove-Item -LiteralPath $archivePath, $checksumPath -Force -ErrorAction SilentlyContinue
}

$env:Path = "$nodeDir;$uvBinDir;$env:Path"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "Installing uv for the current Windows user..."
  $uvInstaller = Join-Path $env:TEMP "open-supercomputer-install-uv.ps1"
  Invoke-WebRequest -Uri "https://astral.sh/uv/install.ps1" -OutFile $uvInstaller
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uvInstaller
  if ($LASTEXITCODE -ne 0) { throw "uv installation failed (exit code $LASTEXITCODE)." }
  Remove-Item -LiteralPath $uvInstaller -Force -ErrorAction SilentlyContinue
  $env:Path = "$nodeDir;$uvBinDir;$env:Path"
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv was installed but could not be found at $uvBinDir. Close this window and run setup again." }

Write-Host "Installing the managed Python 3.12 runtime..."
uv python install 3.12
if ($LASTEXITCODE -ne 0) { throw "Could not install Python 3.12 through uv." }

if (-not (Test-Path -LiteralPath $serviceEnv)) {
  Copy-Item -LiteralPath (Join-Path $serviceDir ".env.example") -Destination $serviceEnv
  Write-Host "Created comfy_service\.env from its example."
}

Write-Host "Installing the web app dependencies..."
$setupDir = Join-Path $runtimeDir "setup"
$dependencyStamp = Join-Path $setupDir "npm-dependencies.sha256"
$null = New-Item -ItemType Directory -Force -Path $setupDir
$packageHash = (Get-FileHash -LiteralPath (Join-Path $root "package.json") -Algorithm SHA256).Hash
$lockHash = (Get-FileHash -LiteralPath (Join-Path $root "package-lock.json") -Algorithm SHA256).Hash
$currentStamp = "$packageHash`n$lockHash"
$needsNpmInstall = -not (Test-Path -LiteralPath (Join-Path $root "node_modules\next")) -or -not (Test-Path -LiteralPath $dependencyStamp)
if (Test-Path -LiteralPath $dependencyStamp) { $needsNpmInstall = $needsNpmInstall -or ((Get-Content -LiteralPath $dependencyStamp -Raw) -ne $currentStamp) }
if ($needsNpmInstall) {
  New-Item -ItemType Directory -Force -Path $setupDir | Out-Null
  Push-Location $root
  try {
    & (Join-Path $nodeDir "npm.cmd") ci
    if ($LASTEXITCODE -ne 0) { throw "Next.js dependency installation failed (exit code $LASTEXITCODE)." }
    Set-Content -LiteralPath $dependencyStamp -Value $currentStamp -NoNewline
  } finally { Pop-Location }
} else { Write-Host "Next.js dependencies are already installed." }

Write-Host "Creating or updating the MCP service virtual environment..."
$env:UV_PROJECT_ENVIRONMENT = Join-Path $serviceDir ".venv-launch"
uv sync --project $serviceDir --frozen --python 3.12
if ($LASTEXITCODE -ne 0) { throw "Comfy MCP dependency setup failed (exit code $LASTEXITCODE)." }

Write-Host "Setup is complete. Starting Open SuperComputer..." -ForegroundColor Green
Start-Process -FilePath (Join-Path $root "start-open-supercomputer.bat") -WorkingDirectory $root
