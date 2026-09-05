param(
  [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"

function Has-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WithWinget {
  param(
    [string]$Id,
    [string]$Name
  )
  if (-not (Has-Command "winget")) {
    throw "winget est introuvable. Installe App Installer depuis Microsoft Store, puis relance ce script."
  }
  Write-Host "Installation: $Name"
  winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
}

function Ensure-Node {
  if ((Has-Command "node") -and (Has-Command "npm")) { return }
  Install-WithWinget -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS"
}

function Ensure-Rust {
  if ((Has-Command "rustup") -and (Has-Command "cargo")) { return }
  Install-WithWinget -Id "Rustlang.Rustup" -Name "Rustup"
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
  }
}

function Ensure-WebView2 {
  $webviewKey = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  if (Test-Path $webviewKey) { return }
  Install-WithWinget -Id "Microsoft.EdgeWebView2Runtime" -Name "Microsoft Edge WebView2 Runtime"
}

function Ensure-BuildTools {
  if (Has-Command "cl") { return }
  $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vsWhere) {
    $installPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationPath
    if ($installPath) { return }
  }
  Install-WithWinget -Id "Microsoft.VisualStudio.2022.BuildTools" -Name "Visual Studio Build Tools 2022"
  Write-Host ""
  Write-Host "Si c'est une premiere installation, ouvre Visual Studio Installer et assure-toi que 'Desktop development with C++' est coche."
  Write-Host "Relance ensuite ce script dans un nouveau PowerShell."
}

Push-Location (Join-Path $PSScriptRoot "..")
try {
  Ensure-Node
  Ensure-Rust
  Ensure-WebView2
  Ensure-BuildTools

  if (-not (Has-Command "node") -or -not (Has-Command "npm")) {
    throw "Node.js/npm introuvable apres installation. Ouvre un nouveau PowerShell et relance ce script."
  }
  if (-not (Has-Command "rustup") -or -not (Has-Command "cargo")) {
    throw "Rust/Cargo introuvable apres installation. Ouvre un nouveau PowerShell et relance ce script."
  }

  rustup target add $Target

  if (Test-Path "package-lock.json") {
    npm ci
  } else {
    npm install
  }

  npm run build
  npm run tauri -- build --target $Target

  Write-Host ""
  Write-Host "Build Windows termine."
  Write-Host "Sorties possibles:"
  Write-Host "  src-tauri\target\$Target\release\"
  Write-Host "  src-tauri\target\$Target\release\bundle\"
} finally {
  Pop-Location
}
