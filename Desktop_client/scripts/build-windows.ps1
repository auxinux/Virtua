<#
  Build the Virtua Desktop client on Windows 11, installing whatever the
  machine is missing first (Node.js, Rust MSVC, WebView2, VS Build Tools).
#>
param(
  [string]$Target = "",
  [string]$Bundles = "nsis"
)

$ErrorActionPreference = "Stop"

function Has-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# An installer writes the machine/user PATH, but this process keeps the one it
# started with: re-read both so a freshly installed tool is usable right away.
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $extra = @(
    (Join-Path $env:USERPROFILE ".cargo\bin"),
    (Join-Path $env:ProgramFiles "nodejs")
  ) | Where-Object { $_ -and (Test-Path $_) }
  $parts = @($machine, $user) + $extra + @($env:Path)
  $env:Path = (($parts -join ";") -split ";" |
    Where-Object { $_ -and $_.Trim() } |
    Select-Object -Unique) -join ";"
}

function Install-WithWinget {
  param([string]$Id, [string]$Name)
  if (-not (Has-Command "winget")) {
    throw "winget est introuvable. Installe 'App Installer' depuis le Microsoft Store, puis relance ce script."
  }
  Write-Host "Installation: $Name"
  # winget returns non-zero when there is simply nothing to do.
  & winget install --id $Id --exact --silent --source winget `
    --accept-package-agreements --accept-source-agreements
  $code = $LASTEXITCODE
  $alreadyInstalled = @(0, -1978335189, -1978335135, -1978335216)
  if ($alreadyInstalled -notcontains $code) {
    throw "L'installation de $Name a echoue (code $code)."
  }
  Sync-Path
}

function Ensure-Node {
  if ((Has-Command "node") -and (Has-Command "npm")) { return }
  Install-WithWinget -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS"
  if (-not (Has-Command "node")) {
    throw "Node.js est installe mais absent du PATH. Ouvre un nouveau PowerShell et relance ce script."
  }
}

function Ensure-Rust {
  if ((Has-Command "rustup") -and (Has-Command "cargo")) { return }
  Install-WithWinget -Id "Rustlang.Rustup" -Name "Rustup"
  if (-not (Has-Command "cargo")) {
    throw "Rust est installe mais absent du PATH. Ouvre un nouveau PowerShell et relance ce script."
  }
}

function Ensure-WebView2 {
  # WebView2 is pre-installed on Windows 11; check both registry views anyway.
  $keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  )
  foreach ($key in $keys) { if (Test-Path $key) { return } }
  Install-WithWinget -Id "Microsoft.EdgeWebView2Runtime" -Name "Microsoft Edge WebView2 Runtime"
}

function Test-MsvcWorkload {
  $vsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vsWhere)) { return $false }
  $found = & $vsWhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
  return [bool]$found
}

function Ensure-BuildTools {
  if (Test-MsvcWorkload) { return }
  Install-WithWinget -Id "Microsoft.VisualStudio.2022.BuildTools" -Name "Visual Studio Build Tools 2022"
  if (-not (Test-MsvcWorkload)) {
    throw @"
Les outils C++ MSVC ne sont pas installes.
Ouvre 'Visual Studio Installer', modifie 'Build Tools 2022' et coche
'Developpement Desktop en C++', puis relance ce script dans un nouveau PowerShell.
"@
  }
}

Push-Location (Join-Path $PSScriptRoot "..")
try {
  Sync-Path

  if (-not $Target) {
    $Target = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
      "aarch64-pc-windows-msvc"
    } else {
      "x86_64-pc-windows-msvc"
    }
  }
  Write-Host "Cible: $Target"

  Ensure-Node
  Ensure-Rust
  Ensure-WebView2
  Ensure-BuildTools

  & rustup target add $Target
  if ($LASTEXITCODE -ne 0) { throw "rustup target add $Target a echoue." }

  if (Test-Path "package-lock.json") { npm ci } else { npm install }
  if ($LASTEXITCODE -ne 0) { throw "L'installation des dependances npm a echoue." }

  npm run build
  if ($LASTEXITCODE -ne 0) { throw "La compilation du frontend a echoue." }

  npm run tauri -- build --target $Target --bundles $Bundles
  if ($LASTEXITCODE -ne 0) { throw "La compilation Tauri a echoue." }

  Write-Host ""
  Write-Host "Build Windows termine ($Target)."
  Write-Host "Sorties: src-tauri\target\$Target\release\bundle\"
} finally {
  Pop-Location
}
