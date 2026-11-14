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
    /// Disposable base being built: once installed, the system becomes a base
    /// (disposable.rs) and this builder VM goes away.
    #[serde(default)]
    pub make_base: bool,
    /// Windows base: when the guest agent first answered (first logon done).
    #[serde(default)]
    pub agent_seen_at: Option<u64>,
    #[serde(default)]
    pub shutdown_requested: bool,
}

/// What the inventory refresh must do after `finish_if_done`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Nothing,
    /// Debian: the installer powered off, boot the installed system.
    Restart,
    /// Base build finished: turn the stopped VM into a disposable base.
    MakeBase(String),
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

/// Preseed of a disposable *base*: the same installation, generalized at the
/// end so every copy gets its own machine-id and SSH host keys on first boot.
pub fn debian_base_preseed(hostname: &str, timezone: &str) -> String {
    let unit = "[Unit]\\nDescription=Virtua: SSH host keys of this copy\\nBefore=ssh.service\\nConditionPathExists=!/etc/ssh/ssh_host_ed25519_key\\n[Service]\\nType=oneshot\\nExecStart=/usr/bin/ssh-keygen -A\\n[Install]\\nWantedBy=multi-user.target\\n";
    format!(
        // log-output: whatever the commands print goes to the installer's log.
        // Printed straight to stdout, it lands on the debconf channel and
        // corrupts the installer (garbled main menu, "continue without boot
        // loader") — `systemctl enable` does print.
        "{}d-i preseed/late_command string log-output -t virtua in-target sh -c 'truncate -s 0 /etc/machine-id; rm -f /etc/ssh/ssh_host_*; printf \"{unit}\" > /etc/systemd/system/virtua-ssh-keys.service; systemctl enable virtua-ssh-keys.service; apt-get clean; true'\n",
        debian_preseed(hostname, timezone)
    )
}

pub fn debian_append(hostname: &str, architecture: &str) -> String {
    // ARM64 `virt` makes the serial port the console: the installer then runs
    // there, offers only the "C" language, rejects the preseeded fr_CA and
    // stops on "Select a language". `console=tty0` puts it on the screen
    // (UEFI framebuffer), as on x86.
    // With UEFI + ACPI the serial port stays the preferred console (ACPI SPCR
    // table) even with console=tty0. acpi=nospcr (Linux 6.8+, Debian 13 has
    // 6.12) keeps ACPI but drops that preference; acpi=off would leave the
    // kernel without any hardware description under UEFI ("empty DTB").
    let console = if architecture == "arm64" { " acpi=nospcr console=tty0" } else { "" };
    format!("auto=true priority=critical language=fr country=CA locale=fr_CA.UTF-8 keymap=ca hostname={hostname} domain=local{console} ---")
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
    // The guest tools bundle and the agent MSI exist only for x86/x64; the
    // drivers themselves are on the disc for both. pnputil installs every
    // `<driver>\w11\<arch>` package (network, serial, balloon, rng, gpu,
    // input…) whatever the disc's letter — on ARM64 that is the only way, and
    // the windowsPE DriverPaths alone did not leave them in the installed
    // Windows (Device Manager full of unknown devices on a Mac).
    //
    // ARM64: the whole virtio-win disc, every subfolder — what Device
    // Manager's "search automatically" on the disc does, and what got every
    // device a driver on a Mac where the w11\ARM64 folders alone left some
    // unknown. Packages of another architecture are refused by pnputil. The
    // disc is told apart from the Windows one by its licence file. x64 keeps
    // the w11 folders (older-OS packages exist for amd64 there).
    // Output goes to C:\Windows\Temp\virtua-drivers.log.
    let drivers = if arch == "arm64" {
        r"cmd /c for %d in (D E F G H I J) do @if exist %d:\virtio-win_license.txt pnputil /add-driver %d:\*.inf /subdirs /install >> C:\Windows\Temp\virtua-drivers.log 2>&1".to_string()
    } else {
        format!(
            r"cmd /c for %d in (D E F G H I J) do @for /d %p in (%d:\*) do @if exist %p\w11\{driver_arch}\*.inf pnputil /add-driver %p\w11\{driver_arch}\*.inf /install >> C:\Windows\Temp\virtua-drivers.log 2>&1"
        )
    };
    let agent = if arch == "arm64" {
        // No ARM64 build of the QEMU guest agent: the x64 one runs under
        // Windows 11's x64 emulation, and is what tells Virtua the install is done.
        (
            "Agent invité QEMU (x64 émulé)",
            r#"cmd /c for %d in (D E F G H I J) do @if exist %d:\guest-agent\qemu-ga-x86_64.msi start "" /wait msiexec /i %d:\guest-agent\qemu-ga-x86_64.msi /qn /norestart"#.to_string(),
        )
    } else {
        (
            "Outils invités VirtIO (agent, pilotes)",
            r#"cmd /c for %d in (D E F G H I J) do @if exist %d:\virtio-win-guest-tools.exe start "" /wait %d:\virtio-win-guest-tools.exe /install /quiet /norestart"#.to_string(),
        )
    };
    let first_logon: String = [
        ("Mot de passe sans expiration", "net accounts /maxpwage:unlimited".to_string()),
        ("Pilotes VirtIO", drivers),
        agent,
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

/// `Windows11*.iso` / `Win11*.iso` of the depot listing.
pub fn is_windows11_iso(name: &str) -> bool {
    let lower = name.to_lowercase();
    (lower.starts_with("windows11") || lower.starts_with("win11")) && lower.ends_with(".iso")
}

/// A released Windows build (`…24h2…`, `…25H2…`) rather than an Insider one
/// (`…_26300_9457…`): Insider builds stop the unattended install at the
/// out-of-box "OOBEZDP" error (the zero-day-patch step fails).
pub fn is_release_windows_iso(name: &str) -> bool {
    let lower = name.to_lowercase();
    let bytes = lower.as_bytes();
    (0..bytes.len().saturating_sub(3)).any(|i| {
        bytes[i].is_ascii_digit()
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2] == b'h'
            && bytes[i + 3].is_ascii_digit()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
            && bytes.get(i + 4).is_none_or(|c| !c.is_ascii_digit())
    })
}

/// Size announced by the server. reqwest's `content_length()` is the size of
/// the *body*, which a HEAD response does not have: it reported 0 for every
/// ISO of the depot, and quick create concluded there was none.
pub fn header_length(response: &reqwest::blocking::Response) -> Option<u64> {
    response.headers().get(reqwest::header::CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

/// Windows 11 installer: one already in the ISO library, else the AuxiNux
/// depot's (amd64). Microsoft offers no stable direct link to its ISOs.
fn windows_iso(app: &tauri::AppHandle, arch: &str) -> Result<PathBuf, String> {
    let config = read_storage_config()?;
    let wants_arm = arch == "arm64";
    let big_enough = |size: u64| size > 3 * 1024 * 1024 * 1024;
    let mut local: Vec<(bool, SystemTime, PathBuf)> = fs::read_dir(&config.iso_dir)
        .map(|entries| entries.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_lowercase();
            let meta = entry.metadata().ok()?;
            let windows = name.ends_with(".iso") && guess_guest_os(Some(&name)) == "windows" && name.contains("11");
            let arm = name.contains("arm");
            (windows && arm == wants_arm && big_enough(meta.len())).then(|| (is_release_windows_iso(&name), meta.modified().unwrap_or(UNIX_EPOCH), path))
        })
        .collect();
    // A released build first, then the newest.
    local.sort();
    let local = local.pop();
    if let Some((true, _, path)) = &local {
        return Ok(path.clone());
    }
    // Only an Insider build here (or nothing): a released one on the depot
    // is worth the download, otherwise keep what we have.
    let fallback = local.map(|(_, _, path)| path);
    let base = repository_url("ISO", arch)?;
    let client = http_client(Duration::from_secs(60))?;
    let listing = match client.get(&base).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()) {
        Ok(listing) => listing,
        Err(e) => return fallback.ok_or_else(|| format!("Dépôt AuxiNux inaccessible : {e}")),
    };
    let mut candidates: Vec<(bool, u64, String)> = listing
        .split("href=\"")
        .skip(1)
        .filter_map(|chunk| chunk.split('"').next())
        .filter(|name| is_windows11_iso(name) && !name.contains('/'))
        .filter_map(|name| {
            let response = client.head(format!("{base}{name}")).send().ok()?;
            let size = header_length(&response)?;
            big_enough(size).then(|| (is_release_windows_iso(name), size, name.to_string()))
        })
        .collect();
    candidates.sort();
    if let Some(path) = fallback {
        if !candidates.last().is_some_and(|(release, _, _)| *release) {
            return Ok(path);
        }
    }
    let Some((_, size, name)) = candidates.pop() else {
        return Err(if wants_arm {
            format!(
                "Aucune ISO Windows 11 ARM64 sur le dépôt AuxiNux ({base}). Microsoft ne publie pas de lien direct : téléchargez-la sur microsoft.com/software-download/windows11arm64 et placez-la dans {}, ou déposez-la dans TEMPLATES/ISO/ARM du dépôt.",
                config.iso_dir
            )
        } else {
            format!("Aucune ISO Windows 11 (plus de 3 Go) sur le dépôt AuxiNux ({base}).")
        });
    };
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
///
/// F12, not Enter: on a fast machine Setup is already copying files within
/// these 25 s, and the focused button of that screen is "Cancel" — an Enter
/// cancelled the install. F12 answers the firmware prompt and does nothing in
/// Setup.
pub(crate) const BOOT_KEY: &str = "f12";

fn press_boot_keys(qmp_port: u16) {
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(25) {
            let _ = qmp_send_key(qmp_port, BOOT_KEY);
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
    quick_create_with(app, os, name, false)
}

/// Quick create of a disposable base: same unattended install, generalized
/// (Debian), then kept as a base by the inventory refresh.
pub fn quick_create_base(app: &tauri::AppHandle, os: &str) -> Result<LocalVm, String> {
    let label = profile(os)?.label;
    quick_create_with(app, os, Some(format!("Base jetable {label} (préparation)")), true)
}

fn quick_create_with(app: &tauri::AppHandle, os: &str, name: Option<String>, make_base: bool) -> Result<LocalVm, String> {
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
        machine: None,
        cpu_model: None,
        period_speed: None,
    };

    let auto = if profile.os == "debian13" {
        progress(app, 2, "Téléchargement de l’installateur Debian 13 (version la plus récente)…");
        let (kernel, initrd) = debian_netboot(app, &arch)?;
        // A base's copies are all "debian-13"; the builder VM's name is not a host name.
        let hostname = if make_base { "debian-13".to_string() } else { host_name(&name, 63).to_lowercase() };
        let original = fs::read(&initrd).map_err(|e| e.to_string())?;
        let dir = local_state_dir()?.join("Unattend").join(safe_file_name(&format!("debian-{}", now_id()))?);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let seeded = dir.join("initrd-preseed.gz");
        let preseed = if make_base { debian_base_preseed("debian-13", &host_timezone()) } else { debian_preseed(&hostname, &host_timezone()) };
        fs::write(&seeded, initrd_with_preseed(&original, &preseed)?).map_err(|e| e.to_string())?;
        AutoInstall {
            os: profile.os.into(),
            make_base,
            kernel: Some(kernel.to_string_lossy().to_string()),
            initrd: Some(seeded.to_string_lossy().to_string()),
            // Boot-parameter aliases of debian-installer: read before the preseed,
            // so even the first screens are in French.
            append: Some(debian_append(&hostname, &arch)),
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
        AutoInstall { os: profile.os.into(), language: Some(language), make_base, ..Default::default() }
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
/// inventory refresh (`process_exited`: the VM's QEMU went away by itself).
pub fn finish_if_done(vm: &mut LocalVm, process_exited: bool) -> InstallOutcome {
    let Some(mut auto) = vm.autoinstall.clone() else { return InstallOutcome::Nothing };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let outcome = match auto.os.as_str() {
        "debian13" if process_exited && auto.kernel.is_some() => {
            vm.autoinstall = None;
            if auto.make_base { InstallOutcome::MakeBase(auto.os.clone()) } else { InstallOutcome::Restart }
        }
        // Windows base: shut down cleanly once the first logon had time to
        // finish (guest tools, RDP, RemoteApp), then keep it as a base.
        "windows11" if auto.make_base && process_exited && auto.shutdown_requested => {
            vm.autoinstall = None;
            vm.iso_path = None;
            vm.driver_iso_path = None;
            windows_arm_display_after_install(vm);
            InstallOutcome::MakeBase(auto.os.clone())
        }
        "windows11" if auto.make_base && vm.guest_agent_running => {
            let seen = *auto.agent_seen_at.get_or_insert(now);
            if !auto.shutdown_requested && now.saturating_sub(seen) >= 120 {
                if let Some(port) = vm.qga_port {
                    // guest-shutdown never answers: the agent goes down with Windows.
                    let _ = qga_execute(port, "guest-shutdown");
                    auto.shutdown_requested = true;
                }
            }
            vm.autoinstall = Some(auto);
            return InstallOutcome::Nothing;
        }
        // The guest agent answers once the guest tools were installed at the
        // first logon: Windows is done, the installer and its answer file go.
        "windows11" if !auto.make_base && vm.guest_agent_running => {
            vm.autoinstall = None;
            vm.iso_path = None;
            vm.driver_iso_path = None;
            windows_arm_display_after_install(vm);
            InstallOutcome::Nothing
        }
        _ => return InstallOutcome::Nothing,
    };
    vm.updated_at = now_string();
    outcome
}

/// Windows on ARM installs on ramfb (the firmware's virtio-gpu screen is
/// blit-only, which Windows setup cannot draw on). Once the first logon has
/// installed viogpudo, virtio-gpu gives a resizable display — from the next
/// start (checked on an Apple Silicon Mac).
fn windows_arm_display_after_install(vm: &mut LocalVm) {
    if vm.architecture == "arm64" && vm.gpu_model == "std" {
        vm.gpu_model = "virtio".to_string();
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
            fs::write(out.join("initrd-base.gz"), initrd_with_preseed(&original, &debian_base_preseed("debian-13", "America/Toronto")).unwrap()).unwrap();
            fs::write(out.join("base-preseed.cfg"), debian_base_preseed("debian-13", "America/Toronto")).unwrap();
        }
    }

    #[test]
    fn the_size_of_a_head_response_comes_from_its_header() {
        // A HEAD answered like nginx does for the 8.4 GB ISO: big
        // Content-Length, no body. content_length() said 0 here.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8376897536\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let response = http_client(Duration::from_secs(5))
            .unwrap()
            .head(format!("http://127.0.0.1:{port}/Windows11.iso"))
            .send()
            .unwrap();
        assert_eq!(header_length(&response), Some(8_376_897_536));
        server.join().unwrap();
    }

    #[test]
    fn windows_isos_of_the_depot_are_recognised() {
        assert!(is_windows11_iso("Windows11-FR_CA-25h2.iso"));
        assert!(is_windows11_iso("Win11_25H2_FrenchCanadian_Arm64.iso"));
        assert!(!is_windows11_iso("debian-13.5.0-amd64-netinst.iso"));
        assert!(!is_windows11_iso("Windows11.iso.part"));
    }

    #[test]
    fn the_arm64_installer_runs_on_the_screen() {
        assert!(debian_append("d", "arm64").contains(" acpi=nospcr console=tty0 ---"));
        assert!(!debian_append("d", "amd64").contains("console="));
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
    fn the_base_preseed_keeps_its_commands_off_the_debconf_channel() {
        let base = debian_base_preseed("debian-13", "UTC");
        let late = base.lines().find(|l| l.starts_with("d-i preseed/late_command")).unwrap();
        assert!(late.contains("string log-output -t virtua in-target sh -c '"));
        assert!(late.trim_end().ends_with("true'"));
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
    fn the_boot_prompt_key_cannot_press_setups_cancel_button() {
        assert_eq!(BOOT_KEY, "f12");
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
            assert!(!inner.replace("&quot;", "").replace("&amp;", "").replace("&gt;", "").replace("&lt;", "").contains('&'), "{inner}");
        }
        // Every element opened is closed (cheap structural check).
        assert_eq!(xml.matches("<component ").count(), xml.matches("</component>").count());
        assert_eq!(xml.matches("<settings ").count(), xml.matches("</settings>").count());
        let arm = windows_answer_file("arm64", "en-US", "W");
        assert!(arm.contains(r"\w11\ARM64") && arm.contains(r#"processorArchitecture="arm64""#));
    }

    #[test]
    fn released_windows_isos_win_over_insider_builds() {
        assert!(is_release_windows_iso("Windows11-FR_CA-25h2.iso"));
        assert!(is_release_windows_iso("Win11_24H2_French_x64.iso"));
        assert!(!is_release_windows_iso("Windows11_Client_x64_fr-ca_26300_9457.iso"));
        assert!(!is_release_windows_iso("Windows11_Client_arm64_en-us_26300_9457.iso"));
        assert!(!is_release_windows_iso("win11-123h45.iso"));
    }

    #[test]
    fn every_virtio_driver_is_installed_at_first_logon_for_its_architecture() {
        let x64 = windows_answer_file("amd64", "fr-CA", "W");
        assert!(x64.contains(r"pnputil /add-driver %p\w11\amd64\*.inf /install"));
        assert!(x64.contains("virtio-win-guest-tools.exe"));
        let arm = windows_answer_file("arm64", "en-US", "W");
        assert!(arm.contains(r"if exist %d:\virtio-win_license.txt pnputil /add-driver %d:\*.inf /subdirs /install"));
        assert!(arm.contains(r"virtua-drivers.log"));
        // The x64 tools bundle cannot install ARM64 drivers: the agent alone, emulated.
        assert!(!arm.contains("virtio-win-guest-tools.exe"));
        assert!(arm.contains(r"msiexec /i %d:\guest-agent\qemu-ga-x86_64.msi /qn"));
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
        assert_eq!(finish_if_done(&mut vm, false), InstallOutcome::Nothing);
        assert_eq!(finish_if_done(&mut vm, true), InstallOutcome::Restart);
        assert!(vm.autoinstall.is_none());

        let mut base = crate::local_mode_tests::sample_vm("amd64", "virtio");
        base.autoinstall = Some(AutoInstall { os: "debian13".into(), kernel: Some("/k".into()), make_base: true, ..Default::default() });
        assert_eq!(finish_if_done(&mut base, true), InstallOutcome::MakeBase("debian13".into()));

        let mut win = crate::local_mode_tests::sample_vm("amd64", "virtio");
        win.iso_path = Some("/w.iso".into());
        win.autoinstall = Some(AutoInstall { os: "windows11".into(), ..Default::default() });
        assert_eq!(finish_if_done(&mut win, false), InstallOutcome::Nothing);
        assert!(win.autoinstall.is_some());
        win.guest_agent_running = true;
        assert_eq!(finish_if_done(&mut win, false), InstallOutcome::Nothing);
        assert!(win.autoinstall.is_none() && win.iso_path.is_none());

        // Windows base: agent seen, shutdown asked after two minutes, base on exit.
        let mut wbase = crate::local_mode_tests::sample_vm("amd64", "virtio");
        wbase.guest_agent_running = true;
        wbase.autoinstall = Some(AutoInstall { os: "windows11".into(), make_base: true, ..Default::default() });
        assert_eq!(finish_if_done(&mut wbase, false), InstallOutcome::Nothing);
        assert!(wbase.autoinstall.as_ref().unwrap().agent_seen_at.is_some());
        wbase.autoinstall.as_mut().unwrap().shutdown_requested = true;
        assert_eq!(finish_if_done(&mut wbase, true), InstallOutcome::MakeBase("windows11".into()));
    }

    #[test]
    fn windows_on_arm_moves_to_virtio_gpu_once_installed() {
        let mut arm = crate::local_mode_tests::sample_vm("arm64", "std");
        arm.guest_agent_running = true;
        arm.autoinstall = Some(AutoInstall { os: "windows11".into(), ..Default::default() });
        assert_eq!(finish_if_done(&mut arm, false), InstallOutcome::Nothing);
        assert_eq!(arm.gpu_model, "virtio");
        // x86 keeps what it has.
        let mut x86 = crate::local_mode_tests::sample_vm("amd64", "std");
        x86.guest_agent_running = true;
        x86.autoinstall = Some(AutoInstall { os: "windows11".into(), ..Default::default() });
        finish_if_done(&mut x86, false);
        assert_eq!(x86.gpu_model, "std");
    }
}

