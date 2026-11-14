//! Unified mode: the Windows apps of a local VM open as ordinary host windows.
//!
//! Windows' own RemoteApp (RDP RAIL) draws each guest window as a separate
//! host window, with its own taskbar/Dock entry. The pieces:
//! - QEMU forwards the guest's RDP port to loopback (`start_local_vm`);
//! - the guest agent switches RDP and RemoteApp on and lists the installed
//!   apps with their icons (PowerShell through `guest-exec`, as SYSTEM);
//! - the host client draws the windows: `mstsc` on Windows, FreeRDP
//!   (`xfreerdp3`/`xfreerdp`) on Linux and macOS (XQuartz);
//! - launchers in the host's app menu run `Virtua Desktop --unified-launch`,
//!   which starts the VM when needed, waits for RDP and opens the app.
use super::*;
use sha2::{Digest, Sha256};
use std::net::ToSocketAddrs;

/// Loopback address the RDP of the VM forwarded on `port` listens on.
///
/// `mstsc` keys saved credentials by host (`TERMSRV/<host>`), not port: on
/// Windows each VM gets its own 127.0.0.x so two VMs never share a password.
/// macOS only configures 127.0.0.1 on lo0.
pub fn loopback_address(port: u16) -> String {
    if cfg!(windows) {
        format!("127.0.0.{}", 10 + (port.saturating_sub(6300) % 240))
    } else {
        "127.0.0.1".to_string()
    }
}

// ── Small codecs (no extra crate for two dozen lines) ──────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0;
    for ch in input.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return Err("base64 invalide".into()),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

/// `powershell -EncodedCommand` takes UTF-16LE base64: no quoting at all
/// survives the trip through the guest agent's command line otherwise.
fn powershell_encoded(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64_encode(&bytes)
}

// ── Guest agent ─────────────────────────────────────────────────────────────

/// One request/response on the guest agent, for commands with arguments and
/// large answers (the app list carries icons). `qga_execute` stays for the
/// cheap periodic probes.
fn qga_call(port: u16, request: &serde_json::Value, timeout: Duration) -> Result<serde_json::Value, String> {
    // One client at a time on the agent's socket (see crate::qga_lock).
    let _guard = crate::qga_lock(port, Duration::from_secs(30)).ok_or("Agent invité occupé : réessayez dans un instant.")?;
    let mut stream = crate::qga_connect(port, Duration::from_millis(800))
        .map_err(|err| format!("Agent invité injoignable : {err}"))?;
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;

    // guest-sync with a fresh id: replies to an earlier client still queued
    // in the channel are skipped until our id comes back.
    let sync_id = u32::from_le_bytes(random_token().as_bytes()[..4].try_into().unwrap_or([7; 4])) as u64;
    let sync = serde_json::json!({ "execute": "guest-sync", "arguments": { "id": sync_id } });
    stream
        .write_all(&[0xff])
        .and_then(|_| stream.write_all(format!("{sync}\n").as_bytes()))
        .map_err(|err| format!("Agent invité : {err}"))?;
    read_reply(&mut stream, timeout.min(Duration::from_secs(5)), |value| {
        value.get("return").and_then(|v| v.as_u64()) == Some(sync_id)
    })
    .map_err(|_| "L’agent invité ne répond pas (QEMU Guest Agent installé dans Windows ?)".to_string())?;

    stream
        .write_all(format!("{request}\n").as_bytes())
        .map_err(|err| format!("Agent invité : {err}"))?;
    let reply = read_reply(&mut stream, timeout, |value| value.get("return").is_some() || value.get("error").is_some())?;
    if let Some(error) = reply.get("error") {
        return Err(format!(
            "Agent invité : {}",
            error.get("desc").and_then(|d| d.as_str()).unwrap_or("erreur")
        ));
    }
    Ok(reply["return"].clone())
}

fn read_reply(
    stream: &mut TcpStream,
    timeout: Duration,
    accept: impl Fn(&serde_json::Value) -> bool,
) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut pending: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 16384];
    loop {
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{fffd}');
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                if accept(&value) {
                    return Ok(value);
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("Délai dépassé en attendant l’agent invité".into());
        }
        match stream.read(&mut buffer) {
            Ok(0) => return Err("Agent invité déconnecté".into()),
            Ok(size) => pending.extend_from_slice(&buffer[..size]),
            Err(err) if matches!(err.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(err) => return Err(format!("Agent invité : {err}")),
        }
    }
}

const POWERSHELL: &str = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/// Where guest commands go: the Agent Virtua when it runs (native, one
/// shared connection), else the QEMU guest agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuestChannel {
    Agent(u16),
    Qga(u16),
}

/// Run a PowerShell script in the guest (as SYSTEM) and return its stdout.
fn guest_powershell(channel: GuestChannel, script: &str, timeout: Duration) -> Result<String, String> {
    let args: Vec<String> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(powershell_encoded(script)))
        .collect();
    let port = match channel {
        GuestChannel::Qga(port) => port,
        GuestChannel::Agent(port) => {
            let (code, stdout, stderr) = crate::agent::exec(port, POWERSHELL, &args, timeout)?;
            let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim_start_matches('\u{feff}').trim().to_string();
            let stdout = text(&stdout);
            if code != 0 {
                let stderr = text(&stderr);
                return Err(format!(
                    "PowerShell (Windows) a échoué ({code}) : {}",
                    stderr.lines().next().unwrap_or(&stdout).chars().take(300).collect::<String>()
                ));
            }
            return Ok(stdout);
        }
    };
    let request = serde_json::json!({
        "execute": "guest-exec",
        "arguments": {
            "path": POWERSHELL,
            "arg": args,
            "capture-output": true,
        }
    });
    let pid = qga_call(port, &request, Duration::from_secs(10))?
        .get("pid")
        .and_then(|p| p.as_i64())
        .ok_or("L’agent invité n’a pas lancé PowerShell")?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let status = qga_call(
            port,
            &serde_json::json!({ "execute": "guest-exec-status", "arguments": { "pid": pid } }),
            Duration::from_secs(20),
        )?;
        if status.get("exited").and_then(|v| v.as_bool()) == Some(true) {
            let decode = |key: &str| {
                status
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(base64_decode)
                    .transpose()
                    .map(|bytes| String::from_utf8_lossy(&bytes.unwrap_or_default()).trim_start_matches('\u{feff}').trim().to_string())
            };
            let stdout = decode("out-data")?;
            let code = status.get("exitcode").and_then(|v| v.as_i64()).unwrap_or(0);
            if code != 0 {
                let stderr = decode("err-data")?;
                return Err(format!(
                    "PowerShell (Windows) a échoué ({code}) : {}",
                    stderr.lines().next().unwrap_or(&stdout).chars().take(300).collect::<String>()
                ));
            }
            return Ok(stdout);
        }
        if std::time::Instant::now() >= deadline {
            return Err("PowerShell ne répond pas dans la VM Windows".into());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// Switch RDP and RemoteApp on. Client editions only allow one session: a
/// RemoteApp logon takes over the console session of the same user, which is
/// what makes the apps appear "on the host" rather than in a second desktop.
const PREPARE_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
if ($cv.EditionID -like 'Core*') {
  @{ ok = $false; edition = $cv.EditionID; reason = 'home' } | ConvertTo-Json -Compress
  exit 0
}
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0 -Type DWord
$allow = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList'
if (-not (Test-Path $allow)) { New-Item -Path $allow -Force | Out-Null }
Set-ItemProperty -Path $allow -Name fDisabledAllowList -Value 1 -Type DWord
$policy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
if (-not (Test-Path $policy)) { New-Item -Path $policy -Force | Out-Null }
Set-ItemProperty -Path $policy -Name fAllowUnlistedRemotePrograms -Value 1 -Type DWord
# Remote Desktop rule group, by resource id: the display name is localized.
try { Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752' } catch { netsh advfirewall firewall set rule group="remote desktop" new enable=Yes | Out-Null }
Set-Service -Name TermService -StartupType Automatic
Start-Service -Name TermService
@{ ok = $true; edition = $cv.EditionID; build = $cv.CurrentBuild } | ConvertTo-Json -Compress
"#;

/// Start-menu shortcuts of every profile, with a 32×32 PNG icon each.
const APPS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$shell = New-Object -ComObject WScript.Shell
$roots = @("$env:ProgramData\Microsoft\Windows\Start Menu\Programs")
Get-ChildItem 'C:\Users' -Directory | ForEach-Object { $roots += (Join-Path $_.FullName 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs') }
$seen = @{}
$apps = New-Object System.Collections.ArrayList
function Add-App($name, $path, $arguments) {
  $key = ($path + '|' + $arguments).ToLower()
  if ($seen.ContainsKey($key)) { return }
  $seen[$key] = 1
  $icon = ''
  try {
    $bitmap = [System.Drawing.Icon]::ExtractAssociatedIcon($path).ToBitmap()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $icon = [Convert]::ToBase64String($stream.ToArray())
  } catch {}
  [void]$apps.Add([pscustomobject]@{ name = $name; path = $path; args = $arguments; icon = $icon })
}
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Recurse -Filter *.lnk | ForEach-Object {
    if ($_.BaseName -match '(?i)uninstall|d.sinstaller|readme|lisez-moi|help|aide|website|site web') { return }
    $link = $shell.CreateShortcut($_.FullName)
    $target = $link.TargetPath
    if (-not $target -or $target -notmatch '(?i)\.exe$' -or -not (Test-Path $target)) { return }
    Add-App $_.BaseName $target $link.Arguments
  }
}
Add-App 'Explorateur de fichiers' "$env:WINDIR\explorer.exe" ''
Add-App 'Invite de commandes' "$env:WINDIR\System32\cmd.exe" ''
Add-App 'Windows PowerShell' "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" ''
ConvertTo-Json -InputObject @($apps) -Compress -Depth 3
"#;

// ── Inventory ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedApp {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: String,
    /// PNG, base64.
    #[serde(default)]
    pub icon: Option<String>,
}

fn app_id(path: &str, args: &str) -> String {
    let digest = Sha256::digest(format!("{}|{}", path.to_lowercase(), args).as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// The guest's JSON (`name/path/args/icon`) → apps sorted by name, with
/// stable ids. Entries without a usable path are dropped.
pub fn parse_guest_apps(raw: &str) -> Result<Vec<UnifiedApp>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(vec![]);
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("Liste d’applications illisible : {e}"))?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        single @ serde_json::Value::Object(_) => vec![single],
        _ => vec![],
    };
    let mut apps: Vec<UnifiedApp> = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim().to_string();
            let path = item.get("path")?.as_str()?.trim().to_string();
            if name.is_empty() || path.is_empty() || path.contains('\n') {
                return None;
            }
            let args = item.get("args").and_then(|a| a.as_str()).unwrap_or("").trim().to_string();
            let icon = item
                .get("icon")
                .and_then(|i| i.as_str())
                .filter(|i| !i.is_empty() && i.len() < 200_000)
                .map(str::to_string);
            Some(UnifiedApp { id: app_id(&path, &args), name, path, args, icon })
        })
        .collect();
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps.dedup_by(|a, b| a.id == b.id);
    Ok(apps)
}

fn vm_dir(vm_id: &str) -> Result<PathBuf, String> {
    let dir = local_state_dir()?.join("Unified").join(safe_file_name(vm_id)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_cached_apps(vm_id: &str) -> Vec<UnifiedApp> {
    vm_dir(vm_id)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("apps.json")).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn find_vm(vm_id: &str) -> Result<LocalVm, String> {
    let _guard = inventory_guard();
    read_local_vms()?
        .into_iter()
        .find(|vm| vm.id == vm_id)
        .ok_or_else(|| "VM locale introuvable".to_string())
}

fn update_vm(vm_id: &str, change: impl FnOnce(&mut LocalVm)) -> Result<LocalVm, String> {
    let _guard = inventory_guard();
    let mut vms = read_local_vms()?;
    let vm = vms.iter_mut().find(|vm| vm.id == vm_id).ok_or("VM locale introuvable")?;
    change(vm);
    vm.updated_at = now_string();
    let updated = vm.clone();
    write_local_vms(&vms)?;
    Ok(updated)
}

fn running_agent_port(vm: &LocalVm) -> Result<GuestChannel, String> {
    if vm.state != "running" {
        return Err(format!("Démarrez « {} » : Windows doit être lancé pour cette étape.", vm.name));
    }
    if let Some(port) = vm.agent_port.filter(|port| crate::agent::ready(*port)) {
        return Ok(GuestChannel::Agent(port));
    }
    vm.qga_port.map(GuestChannel::Qga).ok_or_else(|| "Agent invité indisponible : redémarrez la VM.".to_string())
}

// ── Credentials ─────────────────────────────────────────────────────────────

fn password_entry(vm_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("unified-{}", safe_file_name(vm_id)?)).map_err(|e| e.to_string())
}

/// Store the Windows password of a VM (quick create knows it already).
pub fn remember_password(vm_id: &str, password: &str) -> Result<(), String> {
    password_entry(vm_id)?.set_password(password).map_err(|e| format!("Trousseau indisponible : {e}"))
}

fn load_password(vm_id: &str) -> Result<String, String> {
    password_entry(vm_id)?
        .get_password()
        .map_err(|_| "Mot de passe Windows introuvable dans le trousseau : refaites la préparation du mode Unifié.".to_string())
}

// ── Host client ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Client {
    /// FreeRDP 3: arguments are passed on stdin (`/args-from:stdin`), so the
    /// password never appears in the process list.
    FreeRdp3(String),
    FreeRdp2(String),
    Mstsc(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub available: bool,
    pub kind: Option<String>,
    pub detail: String,
    pub installable: bool,
}

pub fn find_client() -> Option<Client> {
    if cfg!(windows) {
        return find_binary("mstsc").map(Client::Mstsc);
    }
    if let Some(path) = find_binary("xfreerdp3") {
        return Some(Client::FreeRdp3(path));
    }
    let path = find_binary("xfreerdp")?;
    let version = platform::probe(&path, &["--version"]).unwrap_or_default();
    Some(if version.contains("version 2.") { Client::FreeRdp2(path) } else { Client::FreeRdp3(path) })
}

fn xquartz_present() -> bool {
    Path::new("/Applications/Utilities/XQuartz.app").exists() || Path::new("/opt/X11/bin/Xquartz").exists()
}

pub fn client_status() -> ClientStatus {
    match (find_client(), env::consts::OS) {
        (Some(Client::Mstsc(_)), _) => ClientStatus {
            available: true,
            kind: Some("mstsc".into()),
            detail: "Connexion Bureau à distance de Windows (intégrée).".into(),
            installable: false,
        },
        (Some(_), "macos") if !xquartz_present() => ClientStatus {
            available: false,
            kind: Some("freerdp".into()),
            detail: "FreeRDP est installé, il manque XQuartz pour afficher les fenêtres.".into(),
            installable: true,
        },
        (Some(client), _) => ClientStatus {
            available: true,
            kind: Some(if matches!(client, Client::FreeRdp2(_)) { "freerdp2" } else { "freerdp3" }.into()),
            detail: if matches!(client, Client::FreeRdp2(_)) {
                "FreeRDP 2 : fonctionne, FreeRDP 3 est recommandé (mot de passe hors ligne de commande).".into()
            } else {
                "FreeRDP 3 (RemoteApp).".into()
            },
            installable: false,
        },
        (None, "windows") => ClientStatus {
            available: false,
            kind: None,
            detail: "mstsc.exe introuvable : réactivez « Connexion Bureau à distance » dans les fonctionnalités Windows.".into(),
            installable: false,
        },
        (None, os) => ClientStatus {
            available: false,
            kind: None,
            detail: if os == "macos" {
                "Installer FreeRDP et XQuartz (Homebrew) pour afficher les apps Windows.".into()
            } else {
                "Installer FreeRDP (xfreerdp3) pour afficher les apps Windows.".into()
            },
            installable: true,
        },
    }
}

pub fn install_client_script() -> Result<(&'static str, String), String> {
    match env::consts::OS {
        "macos" => Ok(("macos", "brew install freerdp\nbrew install --cask xquartz".into())),
        "linux" => Ok((
            "linux",
            if find_binary("apt-get").is_some() {
                "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y freerdp3-x11 || DEBIAN_FRONTEND=noninteractive apt-get install -y freerdp2-x11"
            } else if find_binary("dnf").is_some() {
                "dnf install -y freerdp"
            } else if find_binary("pacman").is_some() {
                "pacman -S --needed --noconfirm freerdp"
            } else if find_binary("zypper").is_some() {
                "zypper --non-interactive install freerdp"
            } else {
                return Err("Installez FreeRDP (xfreerdp3) via votre gestionnaire de paquets.".into());
            }
            .into(),
        )),
        _ => Err("Windows fournit déjà la Connexion Bureau à distance.".into()),
    }
}

/// Where the RDP of the VM is reachable from the host.
fn rdp_target(vm: &LocalVm) -> Result<(String, u16), String> {
    if let Some(port) = vm.rdp_port {
        return Ok((loopback_address(port), port));
    }
    if normalize_network_mode(Some(vm.network.clone())) != "user" {
        if let Some(ip) = vm.guest_ip.clone() {
            return Ok((ip, 3389));
        }
        return Err("Adresse IP de Windows inconnue : l’agent invité doit être actif.".into());
    }
    Err("Redémarrez la VM une fois : le mode Unifié a besoin d’un port RDP ouvert au démarrage.".into())
}

/// An X.224 connection request answered by a TPKT header: the guest's RDP
/// server is really there. Slirp accepts the TCP connection of a forwarded
/// port even while Windows is still booting, so a TCP connect proves nothing.
pub fn rdp_answers(host: &str, port: u16) -> bool {
    let Some(address) = (host, port).to_socket_addrs().ok().and_then(|mut a| a.next()) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(800)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    // TPKT(4) + X.224 CR(7) + RDP_NEG_REQ(8): TLS | CredSSP.
    let request: [u8; 19] = [
        0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00,
    ];
    if stream.write_all(&request).is_err() {
        return false;
    }
    let mut reply = [0u8; 4];
    matches!(stream.read(&mut reply), Ok(n) if n >= 2 && reply[0] == 0x03 && reply[1] == 0x00)
}

fn freerdp_arguments(client: &Client, host: &str, port: u16, user: &str, password: &str, app: Option<&UnifiedApp>) -> Vec<String> {
    let v3 = matches!(client, Client::FreeRdp3(_));
    let mut args = vec![format!("/v:{host}:{port}"), format!("/u:{user}"), format!("/p:{password}")];
    args.push(if v3 { "/cert:ignore".into() } else { "/cert-ignore".into() });
    match app {
        Some(app) => {
            if v3 {
                // `/app:` options are comma separated: arguments with a comma
                // cannot be expressed and are dropped rather than mangled.
                let mut spec = format!("/app:program:{},name:{}", app.path, app.name.replace(',', " "));
                if !app.args.is_empty() && !app.args.contains(',') {
                    spec.push_str(&format!(",cmd:{}", app.args));
                }
                args.push(spec);
            } else {
                args.push(format!("/app:{}", app.path));
                args.push(format!("/app-name:{}", app.name));
                if !app.args.is_empty() {
                    args.push(format!("/app-cmd:{}", app.args));
                }
            }
            // One WM class per app: the host taskbar groups and pins its
            // windows like those of a native program.
            args.push(format!("/wm-class:virtua-{}", app.id));
        }
        None => {
            args.push("/dynamic-resolution".into());
            args.push("/wm-class:virtua-desktop".into());
        }
    }
    args.extend(["+clipboard".to_string(), "/sound".to_string(), "+auto-reconnect".to_string()]);
    if let Ok(home) = platform::home() {
        let share = if cfg!(target_os = "macos") { "Mac" } else { "Hote" };
        args.push(format!("/drive:{share},{}", home.to_string_lossy()));
    }
    args.push("/log-level:ERROR".into());
    args
}

/// `.rdp` file for `mstsc`. Credentials are not in it: they are saved as a
/// `TERMSRV/<host>` entry in the Windows credential manager.
pub fn rdp_file(host: &str, port: u16, user: &str, app: Option<&UnifiedApp>) -> String {
    let mut lines = vec![
        format!("full address:s:{host}:{port}"),
        format!("username:s:{user}"),
        "prompt for credentials:i:0".into(),
        "promptcredentialonce:i:1".into(),
        // Loopback to our own VM: its self-signed certificate is expected.
        "authentication level:i:0".into(),
        "redirectclipboard:i:1".into(),
        "audiomode:i:0".into(),
        "autoreconnection enabled:i:1".into(),
        "screen mode id:i:1".into(),
        "smart sizing:i:1".into(),
        "dynamic resolution:i:1".into(),
    ];
    if let Some(app) = app {
        lines.extend([
            "remoteapplicationmode:i:1".into(),
            format!("remoteapplicationprogram:s:{}", app.path),
            format!("remoteapplicationname:s:{}", app.name),
            format!("remoteapplicationcmdline:s:{}", app.args),
            "disableremoteappcapscheck:i:1".into(),
        ]);
    }
    lines.join("\r\n") + "\r\n"
}

fn spawn_client(client: &Client, vm: &LocalVm, host: &str, port: u16, user: &str, password: &str, app: Option<&UnifiedApp>) -> Result<(), String> {
    let log = local_state_dir()?.join("Logs").join(format!("{}-unified.log", safe_file_name(&vm.name)?));
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let log_file = fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
    match client {
        Client::Mstsc(binary) => {
            let entry = keyring::Entry::new_with_target(&format!("TERMSRV/{host}"), KEYCHAIN_SERVICE, user).map_err(|e| e.to_string())?;
            entry
                .set_password(password)
                .map_err(|e| format!("Enregistrement des identifiants Windows impossible : {e}"))?;
            let file = vm_dir(&vm.id)?.join(format!("{}.rdp", app.map(|a| a.id.as_str()).unwrap_or("desktop")));
            // UTF-16LE with BOM: mstsc misreads accented app names otherwise.
            let body = rdp_file(host, port, user, app);
            let mut bytes = vec![0xff, 0xfe];
            bytes.extend(body.encode_utf16().flat_map(u16::to_le_bytes));
            fs::write(&file, bytes).map_err(|e| e.to_string())?;
            let mut command = Command::new(binary);
            command.arg(&file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(log_file));
            command.spawn().map_err(|e| format!("Lancement de mstsc impossible : {e}"))?;
        }
        Client::FreeRdp3(binary) | Client::FreeRdp2(binary) => {
            let args = freerdp_arguments(client, host, port, user, password, app);
            let mut command = Command::new(binary);
            if cfg!(target_os = "macos") && env::var_os("DISPLAY").is_none() {
                // XQuartz starts on demand through its launchd socket.
                command.env("DISPLAY", ":0");
            }
            command.stdout(Stdio::from(log_file.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log_file));
            if matches!(client, Client::FreeRdp3(_)) {
                command.arg("/args-from:stdin").stdin(Stdio::piped());
                let mut child = command.spawn().map_err(|e| format!("Lancement de FreeRDP impossible : {e}"))?;
                let mut stdin = child.stdin.take().ok_or("FreeRDP : entrée standard indisponible")?;
                stdin
                    .write_all((args.join("\n") + "\n").as_bytes())
                    .map_err(|e| format!("FreeRDP : {e}"))?;
                drop(stdin);
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            } else {
                command.args(&args).stdin(Stdio::null());
                let mut child = command.spawn().map_err(|e| format!("Lancement de FreeRDP impossible : {e}"))?;
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
        }
    }
    Ok(())
}

// ── Operations ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedVm {
    pub id: String,
    pub name: String,
    pub state: String,
    pub architecture: String,
    pub enabled: bool,
    pub user: Option<String>,
    pub agent: bool,
    /// Agent Virtua version running in the guest, if any.
    pub virtua_agent: Option<String>,
    /// Running, without the Agent Virtua, but with the QEMU agent to push it.
    pub can_install_agent: bool,
    pub rdp_ready: bool,
    pub needs_restart: bool,
    pub apps: Vec<UnifiedApp>,
    pub integrated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedOverview {
    pub client: ClientStatus,
    pub vms: Vec<UnifiedVm>,
}

pub fn overview() -> Result<UnifiedOverview, String> {
    let vms = {
        let _guard = inventory_guard();
        read_local_vms()?
    };
    let windows: Vec<UnifiedVm> = vms
        .into_iter()
        .filter(|vm| vm.guest_os == "windows")
        .map(|vm| {
            let running = vm.state == "running";
            let target = rdp_target(&vm).ok();
            UnifiedVm {
                rdp_ready: running && vm.unified && target.as_ref().is_some_and(|(h, p)| rdp_answers(h, *p)),
                needs_restart: running && target.is_none(),
                integrated: launchers::installed(&vm.id),
                apps: read_cached_apps(&vm.id),
                id: vm.id,
                name: vm.name,
                state: vm.state,
                architecture: vm.architecture,
                enabled: vm.unified,
                user: vm.unified_user,
                agent: vm.guest_agent_running,
                virtua_agent: vm.agent_port.filter(|p| crate::agent::ready(*p)).and(vm.virtua_agent.clone()),
                can_install_agent: running
                    && vm.agent_port.is_some_and(|p| !crate::agent::ready(p))
                    && vm.qga_port.is_some()
                    && vm.guest_agent_running,
            }
        })
        .collect();
    Ok(UnifiedOverview { client: client_status(), vms: windows })
}

/// Put the Agent Virtua into a running Windows VM that has the QEMU guest
/// agent (VMs made before the Agent Virtua): copy the guest-arch binary
/// with guest-file-*, then `virtua-agent.exe install` (service, autostart).
/// The VM's QEMU must have the agent's port, i.e. have started with Virtua
/// Desktop 0.5.0 or later.
pub fn install_agent(vm_id: &str) -> Result<(), String> {
    use base64::Engine;
    let vm = find_vm(vm_id)?;
    if vm.guest_os != "windows" {
        return Err("L'Agent Virtua est pour les VM Windows.".into());
    }
    if vm.state != "running" {
        return Err(format!("Démarrez « {} » d'abord.", vm.name));
    }
    if vm.agent_port.is_none() {
        return Err("Redémarrez la VM une fois (arrêt puis démarrage) : elle n'a pas encore le port de l'Agent Virtua.".into());
    }
    let port = vm.qga_port.ok_or("Agent invité QEMU indisponible : redémarrez la VM.")?;
    let target = r"C:\Windows\Temp\virtua-agent.exe";
    let handle = qga_call(port, &serde_json::json!({ "execute": "guest-file-open", "arguments": { "path": target, "mode": "wb" } }), Duration::from_secs(10))?
        .as_i64()
        .ok_or("L'agent QEMU n'a pas ouvert le fichier")?;
    let binary = crate::agent::agent_binary(&vm.architecture);
    let written = (|| {
        for chunk in binary.chunks(48 * 1024) {
            qga_call(
                port,
                &serde_json::json!({ "execute": "guest-file-write", "arguments": { "handle": handle, "buf-b64": base64::engine::general_purpose::STANDARD.encode(chunk) } }),
                Duration::from_secs(20),
            )?;
        }
        Ok::<(), String>(())
    })();
    let _ = qga_call(port, &serde_json::json!({ "execute": "guest-file-close", "arguments": { "handle": handle } }), Duration::from_secs(10));
    written?;
    let install = format!("& '{target}' install; exit $LASTEXITCODE");
    guest_powershell(GuestChannel::Qga(port), &install, Duration::from_secs(60))?;
    // The agent says hello on its own port within a few seconds.
    for _ in 0..40 {
        if crate::agent::ready(vm.agent_port.unwrap_or(0)) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Agent Virtua installé, mais il ne répond pas encore : redémarrez la VM.".into())
}

pub fn prepare(vm_id: &str, username: &str, password: &str) -> Result<(), String> {
    let username = username.trim();
    if username.is_empty() || username.contains(['\n', '\r']) || password.is_empty() || password.contains(['\n', '\r']) {
        return Err("Indiquez le compte Windows et son mot de passe (RDP refuse les comptes sans mot de passe).".into());
    }
    let vm = find_vm(vm_id)?;
    if vm.guest_os != "windows" {
        return Err("Le mode Unifié est réservé aux VM Windows.".into());
    }
    let port = running_agent_port(&vm)?;
    let raw = guest_powershell(port, PREPARE_SCRIPT, Duration::from_secs(90))?;
    let result: serde_json::Value = serde_json::from_str(raw.lines().last().unwrap_or("{}")).map_err(|_| format!("Réponse de Windows inattendue : {raw}"))?;
    if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        if result.get("reason").and_then(|v| v.as_str()) == Some("home") {
            return Err("Windows Famille ne contient pas de serveur Bureau à distance : le mode Unifié demande Windows 11 Professionnel, Entreprise ou Éducation.".into());
        }
        return Err(format!("Windows a refusé la préparation : {raw}"));
    }
    password_entry(vm_id)?.set_password(password).map_err(|e| format!("Trousseau indisponible : {e}"))?;
    update_vm(vm_id, |vm| {
        vm.unified = true;
        vm.unified_user = Some(username.to_string());
    })?;
    // First inventory right away: the page is useless without it.
    let _ = refresh_apps(vm_id);
    Ok(())
}

pub fn disable(vm_id: &str) -> Result<(), String> {
    let _ = launchers::remove(vm_id);
    if let Ok(entry) = password_entry(vm_id) {
        let _ = entry.delete_credential();
    }
    update_vm(vm_id, |vm| {
        vm.unified = false;
        vm.unified_user = None;
    })?;
    Ok(())
}

pub fn refresh_apps(vm_id: &str) -> Result<Vec<UnifiedApp>, String> {
    let vm = find_vm(vm_id)?;
    let port = running_agent_port(&vm)?;
    let apps = parse_guest_apps(&guest_powershell(port, APPS_SCRIPT, Duration::from_secs(180))?)?;
    let dir = vm_dir(vm_id)?;
    write_json_atomic(&dir.join("apps.json"), &serde_json::to_string(&apps).map_err(|e| e.to_string())?)?;
    if launchers::installed(vm_id) {
        let _ = launchers::install(&vm, &apps);
    }
    Ok(apps)
}

/// Start the VM if needed, wait for Windows' RDP, open `app_id` (or the full
/// desktop with `None`).
pub fn launch(vm_id: &str, app_id: Option<&str>) -> Result<(), String> {
    let client = find_client().ok_or_else(|| client_status().detail)?;
    let mut vm = find_vm(vm_id)?;
    if !vm.unified {
        return Err(format!("Le mode Unifié n’est pas activé pour « {} ».", vm.name));
    }
    let user = vm.unified_user.clone().ok_or("Compte Windows non configuré")?;
    let password = load_password(vm_id)?;
    let app = match app_id {
        Some(id) => Some(
            read_cached_apps(vm_id)
                .into_iter()
                .find(|app| app.id == id)
                .ok_or("Application introuvable : actualisez la liste des applications.")?,
        ),
        None => None,
    };
    if vm.state != "running" {
        vm = {
            let _guard = inventory_guard();
            run_vm_action(vm_id, "start")?
        };
    }
    let (host, port) = rdp_target(&vm)?;
    // A cold Windows boot to the logon screen: a couple of minutes at worst.
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    while !rdp_answers(&host, port) {
        if std::time::Instant::now() >= deadline {
            return Err("Windows ne répond pas en Bureau à distance. Vérifiez que la VM a fini de démarrer.".into());
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
    spawn_client(&client, &vm, &host, port, &user, &password, app.as_ref())
}

/// Entry point of `--unified-launch <vm> [app]`, used by the host launchers.
/// Returns the process exit code; errors are shown in a native dialog since
/// there is no window to show them in.
pub fn cli(args: &[String]) -> i32 {
    let vm = args.first().map(String::as_str).unwrap_or_default();
    let app = args.get(1).map(String::as_str).filter(|a| *a != "desktop");
    match launch(vm, app) {
        Ok(()) => 0,
        Err(error) => {
            log_line(&format!("unified-launch {vm}: {error}"));
            notify_error(&error);
            1
        }
    }
}

fn notify_error(message: &str) {
    let title = "Virtua Desktop — mode Unifié";
    let _ = match env::consts::OS {
        "macos" => platform::probe(
            "osascript",
            &["-e", &format!("display alert {} message {}", serde_json::to_string(title).unwrap_or_default(), serde_json::to_string(message).unwrap_or_default())],
        ),
        "windows" => platform::probe(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                &format!(
                    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show({}, {}) | Out-Null",
                    platform::quote(message),
                    platform::quote(title)
                ),
            ],
        ),
        _ => platform::probe("notify-send", &["--app-name=Virtua Desktop", title, message]),
    };
}

// ── Host launchers ──────────────────────────────────────────────────────────

pub mod launchers {
    use super::*;

    fn slug(value: &str) -> String {
        let slug: String = value
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        if slug.is_empty() { "app".into() } else { slug.chars().take(40).collect() }
    }

    /// Display name, safe as a file name on every OS.
    fn file_label(value: &str) -> String {
        let cleaned: String = value
            .chars()
            .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r') { ' ' } else { c })
            .collect();
        let cleaned = cleaned.trim().trim_matches('.').to_string();
        if cleaned.is_empty() { "App".into() } else { cleaned.chars().take(60).collect() }
    }

    /// The program the launchers run: the AppImage itself rather than its
    /// temporary mount point.
    fn executable() -> Result<String, String> {
        if let Some(appimage) = env::var_os("APPIMAGE") {
            return Ok(appimage.to_string_lossy().to_string());
        }
        env::current_exe().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())
    }

    fn marker(vm_id: &str) -> Result<PathBuf, String> {
        Ok(vm_dir(vm_id)?.join("launchers.json"))
    }

    pub fn installed(vm_id: &str) -> bool {
        marker(vm_id).map(|m| m.is_file()).unwrap_or(false)
    }

    fn icon_png(dir: &Path, app: &UnifiedApp) -> Option<PathBuf> {
        let bytes = base64_decode(app.icon.as_deref()?).ok()?;
        if !bytes.starts_with(b"\x89PNG") {
            return None;
        }
        let path = dir.join(format!("{}.png", app.id));
        fs::write(&path, &bytes).ok()?;
        Some(path)
    }

    /// ICO with the PNG embedded as is (Windows Vista+).
    pub fn ico_from_png(png: &[u8]) -> Vec<u8> {
        let (w, h) = png_size(png).unwrap_or((32, 32));
        let byte = |v: u32| if v >= 256 { 0 } else { v as u8 };
        let mut ico = vec![0, 0, 1, 0, 1, 0, byte(w), byte(h), 0, 0, 1, 0, 32, 0];
        ico.extend((png.len() as u32).to_le_bytes());
        ico.extend(22u32.to_le_bytes());
        ico.extend_from_slice(png);
        ico
    }

    /// ICNS with the PNG as its only representation.
    pub fn icns_from_png(png: &[u8]) -> Vec<u8> {
        let kind: &[u8; 4] = match png_size(png).map(|(w, _)| w).unwrap_or(32) {
            0..=16 => b"icp4",
            17..=32 => b"icp5",
            33..=64 => b"icp6",
            65..=128 => b"ic07",
            129..=256 => b"ic08",
            _ => b"ic09",
        };
        let element = 8 + png.len() as u32;
        let mut icns = b"icns".to_vec();
        icns.extend((8 + element).to_be_bytes());
        icns.extend_from_slice(kind);
        icns.extend(element.to_be_bytes());
        icns.extend_from_slice(png);
        icns
    }

    fn png_size(png: &[u8]) -> Option<(u32, u32)> {
        if png.len() < 24 || &png[12..16] != b"IHDR" {
            return None;
        }
        let w = u32::from_be_bytes(png[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(png[20..24].try_into().ok()?);
        Some((w, h))
    }

    fn launcher_root() -> Result<PathBuf, String> {
        let home = platform::home()?;
        Ok(match env::consts::OS {
            "macos" => home.join("Applications").join("Virtua Apps"),
            "windows" => PathBuf::from(env::var_os("APPDATA").ok_or("APPDATA introuvable")?)
                .join("Microsoft\\Windows\\Start Menu\\Programs\\Virtua Apps"),
            _ => env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or(home.join(".local/share")).join("applications"),
        })
    }

    /// Desktop entry values are not shell-quoted but `Exec` arguments are.
    fn desktop_exec_quote(value: &str) -> String {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('`', "\\`").replace('$', "\\$"))
    }

    pub fn install(vm: &LocalVm, apps: &[UnifiedApp]) -> Result<usize, String> {
        remove(&vm.id)?;
        let exe = executable()?;
        let root = launcher_root()?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let icons = vm_dir(&vm.id)?.join("icons");
        fs::create_dir_all(&icons).map_err(|e| e.to_string())?;
        let mut created: Vec<String> = vec![];
        // Windows: every shortcut in one PowerShell run (one process per app
        // took a minute for a full Start menu).
        let mut windows_shortcuts: Vec<String> = vec![];
        for app in apps {
            let png = icon_png(&icons, app);
            let label = file_label(&app.name);
            let path = match env::consts::OS {
                "macos" => {
                    let bundle = root.join(format!("{label}.app"));
                    let contents = bundle.join("Contents");
                    fs::create_dir_all(contents.join("MacOS")).map_err(|e| e.to_string())?;
                    fs::create_dir_all(contents.join("Resources")).map_err(|e| e.to_string())?;
                    if let Some(png) = png.as_ref().and_then(|p| fs::read(p).ok()) {
                        let _ = fs::write(contents.join("Resources/icon.icns"), icns_from_png(&png));
                    }
                    let plist = format!(
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>CFBundleName</key><string>{name}</string>\n<key>CFBundleDisplayName</key><string>{name}</string>\n<key>CFBundleIdentifier</key><string>ca.auxinux.virtua.unified.{id}</string>\n<key>CFBundleExecutable</key><string>launch</string>\n<key>CFBundleIconFile</key><string>icon</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>LSUIElement</key><true/>\n</dict></plist>\n",
                        name = xml_escape(&app.name),
                        id = app.id
                    );
                    fs::write(contents.join("Info.plist"), plist).map_err(|e| e.to_string())?;
                    let script = contents.join("MacOS/launch");
                    fs::write(
                        &script,
                        format!("#!/bin/sh\nexec {} --unified-launch {} {}\n", platform::quote(&exe), platform::quote(&vm.id), platform::quote(&app.id)),
                    )
                    .map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = fs::set_permissions(&script, fs::Permissions::from_mode(0o755));
                    }
                    bundle
                }
                "windows" => {
                    let link = root.join(format!("{label}.lnk"));
                    let ico = png.as_ref().and_then(|p| fs::read(p).ok()).map(|png| {
                        let path = icons.join(format!("{}.ico", app.id));
                        let _ = fs::write(&path, ico_from_png(&png));
                        path
                    });
                    windows_shortcuts.push(format!(
                        "$s=$w.CreateShortcut({link});$s.TargetPath={exe};$s.Arguments={args};$s.Description={desc};{icon}$s.Save()",
                        link = platform::quote(&link.to_string_lossy()),
                        exe = platform::quote(&exe),
                        args = platform::quote(&format!("--unified-launch {} {}", vm.id, app.id)),
                        desc = platform::quote(&format!("{} (Windows · {})", app.name, vm.name)),
                        icon = ico.map(|i| format!("$s.IconLocation={};", platform::quote(&i.to_string_lossy()))).unwrap_or_default(),
                    ));
                    link
                }
                _ => {
                    let file = root.join(format!("virtua-{}-{}.desktop", slug(&vm.id), app.id));
                    let entry = format!(
                        "[Desktop Entry]\nType=Application\nName={name}\nComment=Windows · {vm} (Virtua Desktop)\nExec={exe} --unified-launch {vmid} {appid}\n{icon}StartupWMClass=virtua-{appid}\nCategories=Virtua;\nTerminal=false\nX-Virtua-VM={vmid}\n",
                        name = app.name.replace(['\n', '\r'], " "),
                        vm = vm.name.replace(['\n', '\r'], " "),
                        exe = desktop_exec_quote(&exe),
                        vmid = desktop_exec_quote(&vm.id),
                        appid = app.id,
                        icon = png.map(|p| format!("Icon={}\n", p.to_string_lossy())).unwrap_or_default(),
                    );
                    fs::write(&file, entry).map_err(|e| e.to_string())?;
                    file
                }
            };
            created.push(path.to_string_lossy().to_string());
        }
        if !windows_shortcuts.is_empty() {
            let script = format!("$w=New-Object -ComObject WScript.Shell;{}", windows_shortcuts.join(";"));
            let mut command = platform::command("powershell");
            command.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &powershell_encoded(&script)]);
            platform::output(command, Duration::from_secs(120)).map_err(|e| format!("Raccourcis Windows : {e}"))?;
        }
        if env::consts::OS == "linux" {
            let _ = platform::probe("update-desktop-database", &[&root.to_string_lossy()]);
        }
        write_json_atomic(&marker(&vm.id)?, &serde_json::to_string(&created).map_err(|e| e.to_string())?)?;
        Ok(created.len())
    }

    /// Remove exactly what `install` created (listed in the marker file).
    pub fn remove(vm_id: &str) -> Result<(), String> {
        let marker = marker(vm_id)?;
        let Ok(raw) = fs::read_to_string(&marker) else { return Ok(()) };
        let root = launcher_root()?;
        let created: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        for path in created.iter().map(PathBuf::from) {
            // Never follow a tampered marker outside the launcher folder.
            if !is_path_inside(&path, &root) {
                continue;
            }
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
        let _ = fs::remove_file(marker);
        Ok(())
    }

    fn xml_escape(value: &str) -> String {
        value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_unified_overview() -> Result<UnifiedOverview, String> {
    blocking(overview).await
}

#[tauri::command]
pub async fn local_unified_prepare(id: String, username: String, password: String) -> Result<(), String> {
    blocking(move || prepare(&id, &username, &password)).await
}

#[tauri::command]
pub async fn local_install_virtua_agent(id: String) -> Result<(), String> {
    blocking(move || install_agent(&id)).await
}

#[tauri::command]
pub async fn local_unified_disable(id: String) -> Result<(), String> {
    blocking(move || disable(&id)).await
}

#[tauri::command]
pub async fn local_unified_refresh_apps(id: String) -> Result<Vec<UnifiedApp>, String> {
    blocking(move || refresh_apps(&id)).await
}

#[tauri::command]
pub async fn local_unified_launch(id: String, app_id: Option<String>) -> Result<(), String> {
    blocking(move || launch(&id, app_id.as_deref())).await
}

#[tauri::command]
pub async fn local_unified_integrate(id: String, enabled: bool) -> Result<usize, String> {
    blocking(move || {
        if !enabled {
            launchers::remove(&id)?;
            return Ok(0);
        }
        let vm = find_vm(&id)?;
        let apps = read_cached_apps(&id);
        if apps.is_empty() {
            return Err("Aucune application connue : actualisez d’abord la liste (Windows démarré).".into());
        }
        launchers::install(&vm, &apps)
    })
    .await
}

#[tauri::command]
pub async fn local_unified_install_client(app: tauri::AppHandle) -> Result<ClientStatus, String> {
    blocking(move || {
        let _guard = engines::SetupGuard::acquire()?;
        let (_, script) = install_client_script()?;
        engines::progress(&app, "unified", "Installation du client Bureau à distance (FreeRDP)…");
        engines::run_admin_script(&script)?;
        platform::forget_caches();
        Ok(client_status())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for sample in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\x00\xff\x10 binary"] {
            assert_eq!(base64_decode(&base64_encode(sample)).unwrap(), sample);
        }
        assert_eq!(base64_encode(b"Virtua"), "VmlydHVh");
    }

    #[test]
    fn powershell_receives_utf16_little_endian() {
        // "A" → 41 00 → "QQA="
        assert_eq!(powershell_encoded("A"), "QQA=");
    }

    #[test]
    fn guest_apps_get_stable_ids_and_are_sorted() {
        let raw = r#"[{"name":"Word","path":"C:\\Office\\WINWORD.EXE","args":"","icon":""},
                     {"name":"cmd","path":"C:\\Windows\\System32\\cmd.exe","args":"","icon":"iVBO"},
                     {"name":"","path":"C:\\x.exe"},
                     {"name":"Word copy","path":"c:\\office\\winword.exe","args":""}]"#;
        let apps = parse_guest_apps(raw).unwrap();
        assert_eq!(apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["cmd", "Word"]);
        assert_eq!(apps[1].id, app_id("C:\\OFFICE\\winword.exe", ""));
        assert_eq!(apps[1].icon, None);
        assert_eq!(apps[0].icon.as_deref(), Some("iVBO"));
        // A single app comes back from ConvertTo-Json as an object.
        assert_eq!(parse_guest_apps(r#"{"name":"a","path":"C:\\a.exe"}"#).unwrap().len(), 1);
    }

    #[test]
    fn freerdp3_opens_a_remoteapp_with_its_own_window_class() {
        let app = UnifiedApp { id: "abc".into(), name: "Paint, Pro".into(), path: "C:\\p.exe".into(), args: "/x".into(), icon: None };
        let args = freerdp_arguments(&Client::FreeRdp3("x".into()), "127.0.0.1", 6301, "me", "pw", Some(&app));
        assert!(args.contains(&"/v:127.0.0.1:6301".to_string()));
        assert!(args.contains(&"/app:program:C:\\p.exe,name:Paint  Pro,cmd:/x".to_string()));
        assert!(args.contains(&"/wm-class:virtua-abc".to_string()));
        assert!(args.contains(&"/cert:ignore".to_string()));
        let v2 = freerdp_arguments(&Client::FreeRdp2("x".into()), "127.0.0.1", 6301, "me", "pw", Some(&app));
        assert!(v2.contains(&"/app:C:\\p.exe".to_string()) && v2.contains(&"/cert-ignore".to_string()));
    }

    #[test]
    fn rdp_files_carry_no_password() {
        let app = UnifiedApp { id: "a".into(), name: "Excel".into(), path: "C:\\x.exe".into(), args: String::new(), icon: None };
        let file = rdp_file("127.0.0.11", 6301, "me", Some(&app));
        assert!(file.contains("full address:s:127.0.0.11:6301\r\n"));
        assert!(file.contains("remoteapplicationmode:i:1"));
        assert!(!file.to_lowercase().contains("password"));
        assert!(!rdp_file("h", 1, "u", None).contains("remoteapplicationmode"));
    }

    #[test]
    fn loopback_addresses_are_per_vm_only_on_windows() {
        if cfg!(windows) {
            assert_eq!(loopback_address(6301), "127.0.0.11");
            assert_ne!(loopback_address(6301), loopback_address(6302));
        } else {
            assert_eq!(loopback_address(6301), "127.0.0.1");
        }
    }

    #[test]
    fn icon_containers_wrap_the_png() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(32u32.to_be_bytes());
        png.extend(32u32.to_be_bytes());
        png.extend([8, 6, 0, 0, 0]);
        let ico = launchers::ico_from_png(&png);
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!(ico[6], 32);
        assert_eq!(&ico[22..], &png[..]);
        let icns = launchers::icns_from_png(&png);
        assert_eq!(&icns[..4], b"icns");
        assert_eq!(&icns[8..12], b"icp5");
        assert_eq!(u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize, icns.len());
    }

    #[test]
    fn a_closed_port_is_not_an_rdp_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!rdp_answers("127.0.0.1", port));
    }

    #[test]
    fn a_tpkt_reply_is_an_rdp_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 19];
            socket.read_exact(&mut request).unwrap();
            assert_eq!(&request[..2], &[0x03, 0x00]);
            socket.write_all(&[0x03, 0x00, 0x00, 0x13]).unwrap();
        });
        assert!(rdp_answers("127.0.0.1", port));
        server.join().unwrap();
    }
}
