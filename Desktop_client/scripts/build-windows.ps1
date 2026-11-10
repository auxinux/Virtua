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

# winget is often blocked by policy or missing (0x80070001...). Every tool
# then comes from its publisher's official installer, checked against the
# checksum the publisher publishes when there is one.
function Try-Winget {
  param([string]$Id, [string]$Name)
  if (-not (Has-Command "winget")) { return $false }
  Write-Host "Installation (winget): $Name"
  & winget install --id $Id --exact --silent --source winget `
    --accept-package-agreements --accept-source-agreements
  $code = $LASTEXITCODE
  # winget returns non-zero when there is simply nothing to do.
  $alreadyInstalled = @(0, -1978335189, -1978335135, -1978335216)
  if ($alreadyInstalled -contains $code) { Sync-Path; return $true }
  Write-Host "winget a echoue pour $Name (code $code) : installateur officiel."
  return $false
}

# Text of a small file, whatever Content-Type the server sends (rustup's
# .sha256 comes as binary/octet-stream, i.e. a byte array in .Content).
function Get-Text {
  param([string]$Url)
  $content = (Invoke-WebRequest -UseBasicParsing -Uri $Url).Content
  if ($content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($content) }
  return [string]$content
}

function Get-Download {
  param([string]$Url, [string]$Name, [string]$Sha256)
  $dir = Join-Path $env:TEMP "virtua-build-tools"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $file = Join-Path $dir $Name
  Write-Host "Telechargement: $Url"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = "SilentlyContinue"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $file
  if ($Sha256) {
    $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256.ToLowerInvariant()) {
      Remove-Item -Force $file
      throw "$Name est corrompu (SHA-256 different)."
    }
  }
  return $file
}

function Invoke-Installer {
  param([string]$File, [string[]]$Arguments, [switch]$Elevated)
  $params = @{ FilePath = $File; ArgumentList = $Arguments; Wait = $true; PassThru = $true }
  if ($Elevated) { $params.Verb = "RunAs" }
  $process = Start-Process @params
  # 3010 = success, reboot requested later.
  if (@(0, 3010) -notcontains $process.ExitCode) {
    throw "L'installateur $File a echoue (code $($process.ExitCode))."
  }
  Sync-Path
}

function Install-NodeDirect {
  $index = Invoke-RestMethod -UseBasicParsing -Uri "https://nodejs.org/dist/index.json"
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -and ($lts.files -contains "win-arm64-msi")) { "arm64" } else { "x64" }
  $msi = "node-$($lts.version)-$arch.msi"
  $sums = Get-Text "https://nodejs.org/dist/$($lts.version)/SHASUMS256.txt"
  $line = ($sums -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape($msi) + "$") } | Select-Object -First 1
  if (-not $line) { throw "Somme de controle de $msi introuvable." }
  $file = Get-Download -Url "https://nodejs.org/dist/$($lts.version)/$msi" -Name $msi -Sha256 (($line -split "\s+")[0])
  Invoke-Installer -File "msiexec.exe" -Arguments @("/i", "`"$file`"", "/qn", "/norestart") -Elevated
}

function Install-RustDirect {
  $triple = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
  $url = "https://static.rust-lang.org/rustup/dist/$triple/rustup-init.exe"
  $sha = ((Get-Text "$url.sha256").Trim() -split "\s+")[0]
  $file = Get-Download -Url $url -Name "rustup-init.exe" -Sha256 $sha
  # Per-user install: no administrator rights needed.
  Invoke-Installer -File $file -Arguments @("-y", "--default-toolchain", "stable", "--profile", "minimal")
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }
}

function Install-WebView2Direct {
  # Microsoft's Evergreen bootstrapper (signed by Microsoft).
  $file = Get-Download -Url "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -Name "MicrosoftEdgeWebview2Setup.exe" -Sha256 ""
  Invoke-Installer -File $file -Arguments @("/silent", "/install") -Elevated
}

function Install-BuildToolsDirect {
  # Microsoft's Visual Studio Build Tools bootstrapper, C++ desktop workload only.
  $file = Get-Download -Url "https://aka.ms/vs/17/release/vs_BuildTools.exe" -Name "vs_BuildTools.exe" -Sha256 ""
  Invoke-Installer -File $file -Arguments @("--quiet", "--wait", "--norestart", "--nocache",
    "--add", "Microsoft.VisualStudio.Workload.VCTools", "--includeRecommended") -Elevated
}

function Ensure-Node {
  if ((Has-Command "node") -and (Has-Command "npm")) { return }
  if (-not (Try-Winget -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS")) { Install-NodeDirect }
  if (-not (Has-Command "node")) {
    throw "Node.js est installe mais absent du PATH. Ouvre un nouveau PowerShell et relance ce script."
  }
}

function Ensure-Rust {
  if ((Has-Command "rustup") -and (Has-Command "cargo")) { return }
  if (-not (Try-Winget -Id "Rustlang.Rustup" -Name "Rustup")) { Install-RustDirect }
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
  if (-not (Try-Winget -Id "Microsoft.EdgeWebView2Runtime" -Name "Microsoft Edge WebView2 Runtime")) { Install-WebView2Direct }
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
  if (-not (Try-Winget -Id "Microsoft.VisualStudio.2022.BuildTools" -Name "Visual Studio Build Tools 2022")) { Install-BuildToolsDirect }
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
