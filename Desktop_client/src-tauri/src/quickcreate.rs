//! Quick create: one click gives a ready, optimally configured VM.
//!
//! - **Debian 13**: the official netboot installer (kernel + initrd, ~45 MB,
//!   always the current point release, checked against Debian's SHA256SUMS),
//!   booted directly by QEMU with a preseed file appended to its initrd. The
//!   installer powers the VM off when done; Virtua then boots it from disk.
//! - **Windows 11**: the ISO of the AuxiNux depot (amd64) or one already in
//!   the ISO library (ARM64: Microsoft gives no direct link), the VirtIO driver
//!   disc, and a complete answer file (disk layout, Pro edition, local account,
//!   no OOBE, VirtIO drivers during setup, guest tools and RDP/RemoteApp at
//!   first logon so the Unified mode works right away).
//!
//! Account on both: `virtua` / `virtua`.
use super::*;
use sha2::{Digest, Sha256};

pub const USER: &str = "virtua";
pub const PASSWORD: &str = "virtua";

/// Unattended installation in progress, stored on the VM.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoInstall {
    /// `windows11` or `debian13`.
    pub os: String,
    /// Debian: installer booted directly (`-kernel`/`-initrd`/`-append`).
    #[serde(default)]
    pub kernel: Option<String>,
    #[serde(default)]
    pub initrd: Option<String>,
    #[serde(default)]
    pub append: Option<String>,
    /// Windows: setup language (`fr-CA`, `en-US`…) of the answer file.
    #[serde(default)]
    pub language: Option<String>,
    /// Windows: "Press any key to boot from CD" was answered on the first
    /// start; never again (a later key press would reinstall over the disk).
    #[serde(default)]
    pub boot_keys_sent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Profile {
    pub os: &'static str,
    pub label: &'static str,
    pub guest_os: &'static str,
    pub cpu: u16,
    pub memory_mib: u32,
    pub disk_gib: u32,
}

pub fn profile(os: &str) -> Result<Profile, String> {
    match os {
        "windows11" => Ok(Profile { os: "windows11", label: "Windows 11", guest_os: "windows", cpu: 4, memory_mib: 4096, disk_gib: 80 }),
        "debian13" => Ok(Profile { os: "debian13", label: "Debian 13", guest_os: "other", cpu: 2, memory_mib: 4096, disk_gib: 60 }),
        _ => Err("Système inconnu pour la création rapide".into()),
    }
}

/// Never more vCPUs than the host has threads.
pub fn effective_cpu(wanted: u16, host_threads: usize) -> u16 {
    wanted.min(u16::try_from(host_threads.max(1)).unwrap_or(u16::MAX)).max(1)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    step: u8,
    total: u8,
    message: String,
}

fn progress(app: &tauri::AppHandle, step: u8, message: impl Into<String>) {
    let _ = app.emit("quick-create-progress", Progress { step, total: 4, message: message.into() });
}

// ── Small helpers ───────────────────────────────────────────────────────────

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hasher.update(&buffer[..size]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Hash of `path` in a Debian `SHA256SUMS` file (`<hash>  ./netboot/…`).
pub fn sha256_for(sums: &str, path: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        (name.trim_start_matches("./") == path.trim_start_matches("./") && hash.len() == 64).then(|| hash.to_lowercase())
    })
}

/// Host name / Windows computer name from the VM name.
pub fn host_name(name: &str, max: usize) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let cut: String = cleaned.chars().take(max).collect();
    let cut = cut.trim_matches('-').to_string();
    if cut.is_empty() { "virtua".into() } else { cut }
}

/// IANA time zone of the host (`America/Toronto`), for the Debian installer.
fn host_timezone() -> String {
    let valid = |tz: &str| !tz.is_empty() && tz.chars().all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c));
    if let Ok(tz) = env::var("TZ") {
        let tz = tz.trim_start_matches(':').to_string();
        if valid(&tz) {
            return tz;
        }
    }
    if let Ok(raw) = fs::read_to_string("/etc/timezone") {
        let tz = raw.trim().to_string();
        if valid(&tz) {
            return tz;
        }
    }
    if let Ok(target) = fs::read_link("/etc/localtime") {
        let text = target.to_string_lossy().to_string();
        if let Some((_, tz)) = text.split_once("zoneinfo/") {
            if valid(tz) {
                return tz.to_string();
            }
        }
    }
    "America/Toronto".into()
}

fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// One file in a `newc` cpio archive (the initramfs format).
pub fn cpio_newc(name: &str, data: &[u8]) -> Vec<u8> {
    fn pad(out: &mut Vec<u8>) {
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    fn entry(out: &mut Vec<u8>, ino: u32, mode: u32, name: &str, data: &[u8]) {
        let fields = [ino, mode, 0, 0, 1, 0, data.len() as u32, 0, 0, 0, 0, name.len() as u32 + 1, 0];
        out.extend_from_slice(b"070701");
        for field in fields {
            out.extend_from_slice(format!("{field:08x}").as_bytes());
        }
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        pad(out);
        out.extend_from_slice(data);
        pad(out);
    }
    let mut out = Vec::new();
    entry(&mut out, 1, 0o100644, name, data);
    entry(&mut out, 0, 0, "TRAILER!!!", &[]);
    out
}

/// The installer's initrd with `/preseed.cfg` added: Linux unpacks every
/// compressed cpio archive concatenated in an initramfs, and debian-installer
/// loads `/preseed.cfg` before asking anything.
pub fn initrd_with_preseed(initrd: &[u8], preseed: &str) -> Result<Vec<u8>, String> {
    use flate2::{write::GzEncoder, Compression};
    let mut encoder = GzEncoder::new(initrd.to_vec(), Compression::default());
    encoder.write_all(&cpio_newc("preseed.cfg", preseed.as_bytes())).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

// ── Debian 13 ───────────────────────────────────────────────────────────────

pub fn debian_preseed(hostname: &str, timezone: &str) -> String {
    format!(
        r#"# Virtua Desktop — installation automatique de Debian 13
d-i debian-installer/locale string fr_CA.UTF-8
d-i debian-installer/language string fr
d-i debian-installer/country string CA
d-i keyboard-configuration/xkb-keymap select ca
d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string {hostname}
d-i netcfg/get_domain string local
d-i netcfg/hostname string {hostname}
d-i hw-detect/load_firmware boolean false
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string
d-i passwd/root-login boolean false
d-i passwd/user-fullname string Virtua
d-i passwd/username string {USER}
d-i passwd/user-password password {PASSWORD}
d-i passwd/user-password-again password {PASSWORD}
d-i user-setup/allow-password-weak boolean true
d-i clock-setup/utc boolean true
d-i time/zone string {timezone}
d-i clock-setup/ntp boolean true
d-i partman-auto/disk string /dev/vda
d-i partman-auto/method string regular
d-i partman-auto/choose_recipe select atomic
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-efi/non_efi_system boolean true
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i apt-setup/non-free-firmware boolean true
d-i apt-setup/services-select multiselect security, updates
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string qemu-guest-agent spice-vdagent sudo
d-i pkgsel/upgrade select full-upgrade
popularity-contest popularity-contest/participate boolean false
d-i grub-installer/only_debian boolean true
d-i grub-installer/bootdev string default
d-i grub-installer/force-efi-extra-removable boolean true
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true
"#
    )
}

pub fn debian_append(hostname: &str) -> String {
    format!("auto=true priority=critical language=fr country=CA locale=fr_CA.UTF-8 keymap=ca hostname={hostname} domain=local ---")
}

fn debian_netboot(app: &tauri::AppHandle, arch: &str) -> Result<(PathBuf, PathBuf), String> {
    let base = format!("https://deb.debian.org/debian/dists/trixie/main/installer-{arch}/current/images");
    let sums = http_client(Duration::from_secs(60))?
        .get(format!("{base}/SHA256SUMS"))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Liste des fichiers Debian inaccessible : {e}"))?;
    let config = read_storage_config()?;
    let dir = PathBuf::from(&config.iso_dir).join(format!("debian-13-netboot-{arch}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut files = vec![];
    for name in ["linux", "initrd.gz"] {
        let remote = format!("netboot/debian-installer/{arch}/{name}");
        let expected = sha256_for(&sums, &remote).ok_or_else(|| format!("{remote} absent de SHA256SUMS"))?;
        let path = dir.join(name);
        // Re-downloaded only when Debian publishes a new point release.
        if !path.is_file() || sha256_file(&path)? != expected {
            download_file_with_progress(app, &format!("debian13-{name}"), &format!("Debian 13 · {name}"), &format!("{base}/{remote}"), &path)?;
            if sha256_file(&path)? != expected {
                let _ = fs::remove_file(&path);
                return Err(format!("Somme de contrôle invalide pour {remote}"));
            }
        }
        files.push(path);
    }
    Ok((files[0].clone(), files[1].clone()))
}

// ── Windows 11 ──────────────────────────────────────────────────────────────

/// Setup language from the ISO name (Microsoft and depot naming).
pub fn windows_language(iso_name: &str) -> &'static str {
    let lower = iso_name.to_lowercase().replace('-', "_");
    if lower.contains("fr_ca") || lower.contains("ca_fr") || lower.contains("frenchcanadian") || lower.contains("french_canadian") {
        "fr-CA"
    } else if lower.contains("french") || lower.contains("fr_fr") {
        "fr-FR"
    } else {
        "en-US"
    }
}

fn input_locale(language: &str) -> &'static str {
    match language {
        "fr-CA" => "0c0c:00001009",
        "fr-FR" => "040c:0000040c",
        _ => "0409:00000409",
    }
}

/// Full answer file: nothing to click from the boot to the desktop.
pub fn windows_answer_file(architecture: &str, language: &str, computer_name: &str) -> String {
    let arch = if architecture == "arm64" { "arm64" } else { "amd64" };
    let driver_arch = if architecture == "arm64" { "ARM64" } else { "amd64" };
    let attrs = format!(
        r#"processorArchitecture="{arch}" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS""#
    );
    // The driver disc's letter depends on how many drives come before it.
    let mut paths = String::new();
    let mut key = 1;
    for letter in ['D', 'E', 'F', 'G', 'H'] {
        for driver in ["viostor", "vioscsi", "NetKVM", "vioserial", "Balloon"] {
            paths.push_str(&format!(
                "        <PathAndCredentials wcm:action=\"add\" wcm:keyValue=\"{key}\"><Path>{letter}:\\{driver}\\w11\\{driver_arch}</Path></PathAndCredentials>\n"
            ));
            key += 1;
        }
    }
    let lab: String = ["BypassTPMCheck", "BypassSecureBootCheck", "BypassRAMCheck", "BypassStorageCheck", "BypassCPUCheck"]
        .iter()
        .enumerate()
        .map(|(i, k)| format!("        <RunSynchronousCommand wcm:action=\"add\"><Order>{}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v {k} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>\n", i + 1))
        .collect();
    let first_logon: String = [
        ("Mot de passe sans expiration", "net accounts /maxpwage:unlimited".to_string()),
        (
            "Outils invités VirtIO (agent, pilotes)",
            r#"cmd /c for %d in (D E F G H I) do @if exist %d:\virtio-win-guest-tools.exe start "" /wait %d:\virtio-win-guest-tools.exe /install /quiet /norestart"#.to_string(),
        ),
        ("Bureau à distance", r"reg add &quot;HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server&quot; /v fDenyTSConnections /t REG_DWORD /d 0 /f".to_string()),
        ("RemoteApp", r"reg add &quot;HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList&quot; /v fDisabledAllowList /t REG_DWORD /d 1 /f".to_string()),
        ("RemoteApp (stratégie)", r"reg add &quot;HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services&quot; /v fAllowUnlistedRemotePrograms /t REG_DWORD /d 1 /f".to_string()),
        ("Pare-feu Bureau à distance", "powershell -NoProfile -Command &quot;Enable-NetFirewallRule -Group '@FirewallAPI.dll,-28752'&quot;".to_string()),
    ]
    .iter()
    .enumerate()
    .map(|(i, (description, command))| {
        let command = if command.contains("&quot;") { command.clone() } else { xml_escape(command) };
        format!(
            "        <SynchronousCommand wcm:action=\"add\"><Order>{}</Order><Description>{}</Description><CommandLine>{}</CommandLine></SynchronousCommand>\n",
            i + 1,
            xml_escape(description),
            command
        )
    })
    .collect();
    let input = input_locale(language);
    let international = |name: &str| {
        format!(
            "    <component name=\"{name}\" {attrs}>\n      <InputLocale>{input}</InputLocale>\n      <SystemLocale>{language}</SystemLocale>\n      <UILanguage>{language}</UILanguage>\n      <UserLocale>{language}</UserLocale>\n"
        )
    };
    let password = format!("<Password><Value>{PASSWORD}</Value><PlainText>true</PlainText></Password>");
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <settings pass="windowsPE">
{intl_pe}      <SetupUILanguage><UILanguage>{language}</UILanguage></SetupUILanguage>
    </component>
    <component name="Microsoft-Windows-PnpCustomizationsWinPE" {attrs}>
      <DriverPaths>
{paths}      </DriverPaths>
    </component>
    <component name="Microsoft-Windows-Setup" {attrs}>
      <RunSynchronous>
{lab}      </RunSynchronous>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Label>System</Label><Format>FAT32</Format></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Label>Windows</Label><Letter>C</Letter><Format>NTFS</Format></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <!-- Generic Windows 11 Pro installation key: selects the edition, does not activate it. -->
        <ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" {attrs}>
      <ComputerName>{computer_name}</ComputerName>
    </component>
    <component name="Microsoft-Windows-Deployment" {attrs}>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE /v BypassNRO /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
{intl_oobe}    </component>
    <component name="Microsoft-Windows-Shell-Setup" {attrs}>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add"><Name>{USER}</Name><DisplayName>Virtua</DisplayName><Group>Administrators</Group>{password}</LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon><Enabled>true</Enabled><Username>{USER}</Username>{password}<LogonCount>9999999</LogonCount></AutoLogon>
      <FirstLogonCommands>
{first_logon}      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
"#,
        intl_pe = international("Microsoft-Windows-International-Core-WinPE"),
        intl_oobe = international("Microsoft-Windows-International-Core"),
    )
}

/// Windows 11 installer: one already in the ISO library, else the AuxiNux
/// depot's (amd64). Microsoft offers no stable direct link to its ISOs.
fn windows_iso(app: &tauri::AppHandle, arch: &str) -> Result<PathBuf, String> {
    let config = read_storage_config()?;
    let wants_arm = arch == "arm64";
    let big_enough = |size: u64| size > 3 * 1024 * 1024 * 1024;
    let mut local: Vec<(SystemTime, PathBuf)> = fs::read_dir(&config.iso_dir)
        .map(|entries| entries.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_lowercase();
            let meta = entry.metadata().ok()?;
            let windows = name.ends_with(".iso") && guess_guest_os(Some(&name)) == "windows" && name.contains("11");
            let arm = name.contains("arm");
            (windows && arm == wants_arm && big_enough(meta.len())).then(|| (meta.modified().unwrap_or(UNIX_EPOCH), path))
        })
        .collect();
    local.sort();
    if let Some((_, path)) = local.pop() {
        return Ok(path);
    }
    if wants_arm {
        return Err(format!(
            "Microsoft ne publie pas de lien direct vers Windows 11 ARM64. Téléchargez l’ISO sur microsoft.com/software-download/windows11arm64, placez-la dans {} puis relancez la création rapide.",
            config.iso_dir
        ));
    }
    let base = repository_url("ISO", "amd64")?;
    let client = http_client(Duration::from_secs(60))?;
    let listing = client
        .get(&base)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Dépôt AuxiNux inaccessible : {e}"))?;
    let mut candidates: Vec<(u64, String)> = listing
        .split("href=\"")
        .skip(1)
        .filter_map(|chunk| chunk.split('"').next())
        .filter(|name| name.to_lowercase().starts_with("windows11") && name.to_lowercase().ends_with(".iso") && !name.contains('/'))
        .filter_map(|name| {
            let size = client.head(format!("{base}{name}")).send().ok()?.content_length()?;
            big_enough(size).then(|| (size, name.to_string()))
        })
        .collect();
    candidates.sort();
    let (size, name) = candidates.pop().ok_or("Aucune ISO Windows 11 disponible sur le dépôt AuxiNux")?;
    let name = html_unescape(&name);
    let destination = PathBuf::from(&config.iso_dir).join(safe_download_name(&name)?);
    let free = sysinfo::Disks::new_with_refreshed_list()
        .iter()
        .filter(|d| Path::new(&config.iso_dir).starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space());
    if let Some(free) = free {
        // The ISO plus room for the system the VM writes first (its qcow2 grows on demand).
        let needed = size + 10 * 1024 * 1024 * 1024;
        if free < needed {
            return Err(format!(
                "Espace insuffisant : l’ISO Windows ({:.1} Go) et le disque de la VM demandent environ {:.0} Go libres.",
                size as f64 / 1e9,
                needed as f64 / 1e9
            ));
        }
    }
    download_file_with_progress(app, "windows11-iso", &name, &format!("{base}{name}"), &destination)?;
    Ok(destination)
}

/// Answer "Press any key to boot from CD or DVD" on the very first start of a
/// Windows install: without a key the firmware falls through to the empty
/// disk and stops. Keys only for a few seconds, never on a later start.
fn press_boot_keys(qmp_port: u16) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(25) {
            let _ = qmp_send_key(qmp_port, "ret");
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

fn qmp_send_key(port: u16, key: &str) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_millis(500))).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 4096];
    let _ = stream.read(&mut buffer);
    stream.write_all(b"{\"execute\":\"qmp_capabilities\"}\r\n").map_err(|e| e.to_string())?;
    let _ = stream.read(&mut buffer);
    let command = serde_json::json!({"execute": "send-key", "arguments": {"keys": [{"type": "qcode", "data": key}]}});
    stream.write_all(format!("{command}\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let _ = stream.read(&mut buffer);
    Ok(())
}

// ── The whole flow ──────────────────────────────────────────────────────────

fn unique_name(wanted: &str, vms: &[LocalVm]) -> String {
    let taken = |n: &str| vms.iter().any(|vm| vm.name.eq_ignore_ascii_case(n));
    if !taken(wanted) {
        return wanted.to_string();
    }
    (2..).map(|i| format!("{wanted} ({i})")).find(|n| !taken(n)).unwrap_or_else(|| wanted.to_string())
}

pub fn quick_create(app: &tauri::AppHandle, os: &str, name: Option<String>) -> Result<LocalVm, String> {
    let profile = profile(os)?;
    progress(app, 1, "Vérification de QEMU…");
    let diagnostics = qemu_diagnostics_blocking()?;
    if !diagnostics.ready {
        return Err("QEMU n’est pas prêt : préparez-le dans Configuration → Moteurs locaux.".into());
    }
    let arch = diagnostics.host_arch.clone();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let wanted = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| profile.label.to_string());
    let name = {
        let _guard = inventory_guard();
        unique_name(&wanted, &read_local_vms()?)
    };

    let mut payload = LocalCreateVmPayload {
        name: name.clone(),
        architecture: arch.clone(),
        cpu: effective_cpu(profile.cpu, threads),
        memory_mib: profile.memory_mib,
        disk_gib: profile.disk_gib,
        iso_path: None,
        driver_iso_path: None,
        guest_os: Some(profile.guest_os.into()),
        windows_setup_bypass: Some(true),
        network: Some("user".into()),
        network_model: Some("virtio".into()),
        gpu_model: Some(if arch == "arm64" && profile.guest_os == "windows" { "std" } else { "virtio" }.into()),
        // Windows ARM sees NVMe without drivers; elsewhere virtio-blk (drivers
        // loaded from the VirtIO disc by the answer file on Windows x64).
        disk_bus: Some(if arch == "arm64" && profile.guest_os == "windows" { "nvme" } else { "virtio" }.into()),
        tpm2: Some(profile.guest_os == "windows"),
        secure_boot: Some(profile.guest_os == "windows"),
    };

    let auto = if profile.os == "debian13" {
        progress(app, 2, "Téléchargement de l’installateur Debian 13 (version la plus récente)…");
        let (kernel, initrd) = debian_netboot(app, &arch)?;
        let hostname = host_name(&name, 63).to_lowercase();
        let original = fs::read(&initrd).map_err(|e| e.to_string())?;
        let dir = local_state_dir()?.join("Unattend").join(safe_file_name(&format!("debian-{}", now_id()))?);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let seeded = dir.join("initrd-preseed.gz");
        fs::write(&seeded, initrd_with_preseed(&original, &debian_preseed(&hostname, &host_timezone()))?).map_err(|e| e.to_string())?;
        AutoInstall {
            os: profile.os.into(),
            kernel: Some(kernel.to_string_lossy().to_string()),
            initrd: Some(seeded.to_string_lossy().to_string()),
            // Boot-parameter aliases of debian-installer: read before the preseed,
            // so even the first screens are in French.
            append: Some(debian_append(&hostname)),
            ..Default::default()
        }
    } else {
        progress(app, 2, "Préparation de l’ISO Windows 11 et des pilotes VirtIO…");
        let iso = windows_iso(app, &arch)?;
        let config = read_storage_config()?;
        let drivers = PathBuf::from(&config.iso_dir).join(VIRTIO_WIN_NAME);
        if !drivers.is_file() {
            let url = virtio_win_url(&arch);
            download_file_with_progress(app, VIRTIO_WIN_NAME, VIRTIO_WIN_NAME, url, &drivers)?;
        }
        let language = windows_language(&iso.file_name().unwrap_or_default().to_string_lossy()).to_string();
        payload.iso_path = Some(iso.to_string_lossy().to_string());
        payload.driver_iso_path = Some(drivers.to_string_lossy().to_string());
        AutoInstall { os: profile.os.into(), language: Some(language), ..Default::default() }
    };

    progress(app, 3, format!("Création de « {name} » : {} vCPU, {} Mio, {} Gio…", payload.cpu, payload.memory_mib, payload.disk_gib));
    let created = {
        let _guard = inventory_guard();
        let vm = local_create_vm_blocking(payload)?;
        let mut vms = read_local_vms()?;
        let entry = vms.iter_mut().find(|v| v.id == vm.id).ok_or("VM créée introuvable")?;
        entry.autoinstall = Some(auto);
        if profile.guest_os == "windows" {
            // Same account as the answer file: the Unified mode is ready as
            // soon as Windows has finished its first logon.
            entry.unified = true;
            entry.unified_user = Some(USER.into());
        }
        let created = entry.clone();
        write_local_vms(&vms)?;
        created
    };
    if profile.guest_os == "windows" {
        let _ = unified::remember_password(&created.id, PASSWORD);
    }

    progress(app, 4, "Démarrage de la VM et de l’installation automatique…");
    let started = {
        let _guard = inventory_guard();
        run_vm_action(&created.id, "start")?
    };
    if profile.guest_os == "windows" {
        if let Some(port) = started.qmp_port {
            press_boot_keys(port);
        }
        let _guard = inventory_guard();
        let mut vms = read_local_vms()?;
        if let Some(auto) = vms.iter_mut().find(|v| v.id == created.id).and_then(|v| v.autoinstall.as_mut()) {
            auto.boot_keys_sent = true;
        }
        write_local_vms(&vms)?;
    }
    Ok(started)
}

/// What a finished unattended install leaves behind, applied by the
/// inventory refresh. Returns true when the VM must be started again (Debian:
/// the installer powered off, the system now boots from disk).
pub fn finish_if_done(vm: &mut LocalVm, process_exited: bool) -> bool {
    let Some(auto) = vm.autoinstall.clone() else { return false };
    match auto.os.as_str() {
        "debian13" if process_exited && auto.kernel.is_some() => {
            vm.autoinstall = None;
            vm.updated_at = now_string();
            true
        }
        // The guest agent answers once the guest tools were installed at the
        // first logon: Windows is done, the installer and its answer file go.
        "windows11" if vm.guest_agent_running => {
            vm.autoinstall = None;
            vm.iso_path = None;
            vm.driver_iso_path = None;
            vm.updated_at = now_string();
            false
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn local_quick_create(app: tauri::AppHandle, os: String, name: Option<String>) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || quick_create(&app, &os, name))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn dump_install_media() {
        let out = PathBuf::from(std::env::var("VIRTUA_DUMP").expect("VIRTUA_DUMP"));
        fs::write(out.join("autounattend-amd64.xml"), windows_answer_file("amd64", "fr-CA", "WINDOWS-11")).unwrap();
        fs::write(out.join("autounattend-arm64.xml"), windows_answer_file("arm64", "en-US", "W11")).unwrap();
        if let Ok(initrd) = std::env::var("VIRTUA_INITRD") {
            let original = fs::read(initrd).unwrap();
            fs::write(out.join("initrd-preseed.gz"), initrd_with_preseed(&original, &debian_preseed("debian-13", "America/Toronto")).unwrap()).unwrap();
        }
    }

    #[test]
    fn profiles_match_the_requested_sizes() {
        let w = profile("windows11").unwrap();
        assert_eq!((w.cpu, w.memory_mib, w.disk_gib), (4, 4096, 80));
        let d = profile("debian13").unwrap();
        assert_eq!((d.cpu, d.memory_mib, d.disk_gib), (2, 4096, 60));
        assert!(profile("macos").is_err());
        assert_eq!(effective_cpu(4, 2), 2);
        assert_eq!(effective_cpu(4, 16), 4);
    }

    #[test]
    fn debian_checksums_are_looked_up_by_path() {
        let sums = "57303d157cffce3fa402301667fbc9b2280aa7372082b081e777375ae49da5f2  ./netboot/debian-installer/amd64/initrd.gz\n\
                    2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08  ./netboot/debian-installer/amd64/linux\n";
        assert_eq!(
            sha256_for(sums, "netboot/debian-installer/amd64/linux").as_deref(),
            Some("2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08")
        );
        assert_eq!(sha256_for(sums, "netboot/debian-installer/arm64/linux"), None);
    }

    #[test]
    fn the_preseed_is_appended_as_a_valid_cpio_archive() {
        let cpio = cpio_newc("preseed.cfg", b"d-i x string y\n");
        assert!(cpio.starts_with(b"070701"));
        assert_eq!(cpio.len() % 4, 0);
        assert!(cpio.windows(10).any(|w| w == b"TRAILER!!!"));
        // name size field (offset 6 + 11*8) = len("preseed.cfg") + NUL
        assert_eq!(&cpio[94..102], b"0000000c");

        let original = b"\x1f\x8boriginal-initrd".to_vec();
        let combined = initrd_with_preseed(&original, "d-i x string y\n").unwrap();
        assert!(combined.starts_with(&original));
        let mut decoder = flate2::read::GzDecoder::new(&combined[original.len()..]);
        let mut unpacked = Vec::new();
        decoder.read_to_end(&mut unpacked).unwrap();
        assert_eq!(unpacked, cpio_newc("preseed.cfg", b"d-i x string y\n"));
    }

    #[test]
    fn the_debian_preseed_answers_everything_with_the_virtua_account() {
        let preseed = debian_preseed("debian-13", "America/Toronto");
        for line in [
            "d-i passwd/username string virtua",
            "d-i passwd/user-password password virtua",
            "d-i netcfg/get_hostname string debian-13",
            "d-i time/zone string America/Toronto",
            "d-i partman-auto/disk string /dev/vda",
            "d-i debian-installer/exit/poweroff boolean true",
        ] {
            assert!(preseed.contains(line), "{line}");
        }
    }

    #[test]
    fn the_windows_answer_file_is_complete_and_well_formed() {
        let xml = windows_answer_file("amd64", "fr-CA", "WIN11");
        assert!(xml.contains("<UILanguage>fr-CA</UILanguage>"));
        assert!(xml.contains("<InputLocale>0c0c:00001009</InputLocale>"));
        assert!(xml.contains(r"<Path>E:\viostor\w11\amd64</Path>"));
        assert!(xml.contains("<Name>virtua</Name>"));
        assert!(xml.contains("<ComputerName>WIN11</ComputerName>"));
        assert!(xml.contains("VK7JG-NPHTM-C97JM-9MPGT-3V66T"));
        assert!(xml.contains("virtio-win-guest-tools.exe"));
        // No raw ampersand or angle bracket inside a command line.
        for line in xml.lines().filter(|l| l.contains("<CommandLine>")) {
            let inner = line.split("<CommandLine>").nth(1).unwrap().split("</CommandLine>").next().unwrap();
            assert!(!inner.contains('<') && !inner.contains('>'), "{inner}");
            assert!(!inner.replace("&quot;", "").replace("&amp;", "").contains('&'), "{inner}");
        }
        // Every element opened is closed (cheap structural check).
        assert_eq!(xml.matches("<component ").count(), xml.matches("</component>").count());
        assert_eq!(xml.matches("<settings ").count(), xml.matches("</settings>").count());
        let arm = windows_answer_file("arm64", "en-US", "W");
        assert!(arm.contains(r"\w11\ARM64") && arm.contains(r#"processorArchitecture="arm64""#));
    }

    #[test]
    fn languages_and_names_follow_the_iso_and_the_vm() {
        assert_eq!(windows_language("Windows11-FR_CA-25h2.iso"), "fr-CA");
        assert_eq!(windows_language("Win11_25H2_FrenchCanadian_x64.iso"), "fr-CA");
        assert_eq!(windows_language("Win11_25H2_French_x64.iso"), "fr-FR");
        assert_eq!(windows_language("Win11_25H2_English_x64.iso"), "en-US");
        assert_eq!(host_name("Windows 11 (2)", 15), "Windows-11-2");
        assert_eq!(host_name("Été!", 15), "t");
        assert_eq!(host_name("!!!", 15), "virtua");
    }

    #[test]
    fn a_finished_install_boots_from_disk() {
        let mut vm = crate::local_mode_tests::sample_vm("amd64", "virtio");
        vm.autoinstall = Some(AutoInstall { os: "debian13".into(), kernel: Some("/k".into()), ..Default::default() });
        assert!(!finish_if_done(&mut vm, false));
        assert!(finish_if_done(&mut vm, true));
        assert!(vm.autoinstall.is_none());

        let mut win = crate::local_mode_tests::sample_vm("amd64", "virtio");
        win.iso_path = Some("/w.iso".into());
        win.autoinstall = Some(AutoInstall { os: "windows11".into(), ..Default::default() });
        assert!(!finish_if_done(&mut win, false));
        assert!(win.autoinstall.is_some());
        win.guest_agent_running = true;
        assert!(!finish_if_done(&mut win, false));
        assert!(win.autoinstall.is_none() && win.iso_path.is_none());
    }
}
