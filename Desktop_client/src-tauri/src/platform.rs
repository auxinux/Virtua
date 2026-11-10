//! Platform-specific paths, process execution and QEMU acceleration.
use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

pub fn home() -> Result<PathBuf, String> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| "Dossier utilisateur introuvable".into())
}
pub fn data_dir() -> Result<PathBuf, String> {
    let base = match env::consts::OS {
        "macos" => home()?.join("Library/Application Support"),
        "windows" => env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or(home()?.join("AppData/Local")),
        _ => env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or(home()?.join(".local/share")),
    };
    Ok(base.join("AuxiNux Virtua Desktop"))
}

/// Directories searched for third-party binaries, in priority order.
/// PATH first, then the well-known install roots of every supported OS —
/// a freshly installed QEMU/Docker is usable without restarting the session,
/// which is exactly the case right after the in-app setup runs.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();

    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(key).map(PathBuf::from) {
                dirs.extend([
                    root.join("qemu"),
                    root.join("QEMU"),
                    root.join("Docker/Docker/resources/bin"),
                    root.join("Git/usr/bin"),
                ]);
            }
        }
        dirs.extend([
            PathBuf::from("C:\\qemu"),
            PathBuf::from("C:\\Program Files\\qemu"),
        ]);
        if let Some(root) = env::var_os("SystemRoot").map(PathBuf::from) {
            dirs.extend([
                root.join("System32"),
                root.join("System32/OpenSSH"),
                root.join("System32/WindowsPowerShell/v1.0"),
            ]);
        }
        if let Some(root) = env::var_os("ProgramData").map(PathBuf::from) {
            dirs.push(root.join("chocolatey/bin"));
        }
        if let Ok(home) = home() {
            dirs.extend([
                home.join("AppData/Local/Microsoft/WindowsApps"),
                home.join("scoop/shims"),
                home.join(".cargo/bin"),
            ]);
        }
        dirs.extend([
            PathBuf::from("C:\\msys64\\ucrt64\\bin"),
            PathBuf::from("C:\\msys64\\mingw64\\bin"),
        ]);
    } else {
        dirs.extend(
            [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
                "/opt/local/bin",
                "/usr/bin",
                "/usr/sbin",
                "/bin",
                "/sbin",
                "/usr/libexec",
                "/snap/bin",
                "/var/lib/flatpak/exports/bin",
                "/Applications/Docker.app/Contents/Resources/bin",
            ]
            .map(PathBuf::from),
        );
        if let Ok(home) = home() {
            dirs.extend([home.join(".local/bin"), home.join("bin")]);
        }
    }

    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()));
    dirs
}

/// Every plausible on-disk location of `binary`, including the Windows
/// executable suffixes so `docker`/`winget` resolve to their real launchers.
pub fn candidates(binary: &str) -> Vec<PathBuf> {
    let names: Vec<String> = if cfg!(windows) && !binary.contains('.') {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{binary}.{ext}"))
            .collect()
    } else {
        vec![binary.to_string()]
    };
    // An absolute path is already the answer; do not prefix it with a directory.
    if Path::new(binary).is_absolute() {
        return vec![PathBuf::from(binary)];
    }
    search_dirs()
        .into_iter()
        .flat_map(|dir| {
            names
                .iter()
                .map(move |name| dir.join(name))
                .collect::<Vec<_>>()
        })
        .collect()
}
pub fn command(program: &str) -> Command {
    let mut cmd = Command::new(find_binary(program).unwrap_or_else(|| program.into()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.env("LC_ALL", "C");
    cmd
}
/// Bound diagnostic commands; drain both pipes while the process runs.
pub fn output(mut cmd: Command, timeout: Duration) -> Result<String, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Sortie standard indisponible")?;
    let stderr = child.stderr.take().ok_or("Sortie erreur indisponible")?;
    let read = |mut pipe: Box<dyn Read + Send>| {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    };
    let out = std::thread::spawn(move || read(Box::new(stdout)));
    let err = std::thread::spawn(move || read(Box::new(stderr)));
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Délai dépassé. Consultez les journaux puis réessayez.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default())
        .trim()
        .to_string();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default())
        .trim()
        .to_string();
    if status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() {
            format!("{status}: {stdout}")
        } else {
            stderr
        })
    }
}
pub fn probe(program: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = command(program);
    cmd.args(args);
    output(cmd, Duration::from_secs(8))
}
pub fn acceleration(os: &str, host: &str, guest: &str) -> &'static str {
    if host != guest {
        return "tcg";
    }
    match os {
        "macos" => "hvf",
        "linux" => "kvm",
        "windows" if guest == "amd64" => "whpx",
        _ => "tcg",
    }
}

/// Probing QEMU costs a process spawn; the answer cannot change while the app
/// runs, and it used to be re-probed on every VM start and every diagnostic
/// refresh — enough to freeze the UI on Windows.
static ACCELERATORS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn accelerator(guest: &str) -> String {
    if let Ok(cache) = ACCELERATORS.lock() {
        if let Some(found) = cache.as_ref().and_then(|map| map.get(guest)).cloned() {
            return found;
        }
    }
    let value = detect_accelerator(guest);
    if let Ok(mut cache) = ACCELERATORS.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(guest.to_string(), value.clone());
    }
    value
}

fn detect_accelerator(guest: &str) -> String {
    let desired = acceleration(env::consts::OS, &normalize_arch(env::consts::ARCH), guest);
    if desired == "tcg" {
        return "tcg".into();
    }
    if desired == "kvm"
        && fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/kvm")
            .is_err()
    {
        return "tcg".into();
    }
    let binary = qemu_system_binary(guest);
    match probe(binary, &["-accel", "help"]) {
        Ok(list) if list.lines().any(|s| s.trim() == desired) => desired.into(),
        _ => "tcg".into(),
    }
}

/// `-device help` of the QEMU for `arch`, probed once: a device model's
/// availability depends on the QEMU build (upstream vs UTM's fork).
static DEVICES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn qemu_has_device(arch: &str, device: &str) -> bool {
    let cached = DEVICES
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().and_then(|map| map.get(arch)).cloned());
    let list = cached.unwrap_or_else(|| {
        let list = probe(qemu_system_binary(arch), &["-device", "help"]).unwrap_or_default();
        if let Ok(mut cache) = DEVICES.lock() {
            cache
                .get_or_insert_with(HashMap::new)
                .insert(arch.to_string(), list.clone());
        }
        list
    });
    list.contains(&format!("\"{}\"", device))
}

/// Resolving a binary walks ~30 directories; on Windows, with Defender in the
/// path, doing that several times per UI refresh was measurable. Cache it, and
/// forget everything after an engine installation changed the machine.
static BINARIES: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

pub fn resolve(binary: &str) -> Option<String> {
    if let Ok(cache) = BINARIES.lock() {
        if let Some(found) = cache.as_ref().and_then(|map| map.get(binary)) {
            return found.clone();
        }
    }
    let found = candidates(binary)
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string());
    if let Ok(mut cache) = BINARIES.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(binary.to_string(), found.clone());
    }
    found
}

/// Forget the cached probes after an engine installation changed the machine.
pub fn forget_caches() {
    if let Ok(mut cache) = ACCELERATORS.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = DEVICES.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = BINARIES.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = PROFILE.lock() {
        *cache = None;
    }
}

/// Windows hands a process its PATH at creation: a tool installed by winget
/// during this session is invisible until relaunch. Re-read the machine and
/// user PATH so the freshly installed engine is usable right away.
#[cfg(windows)]
pub fn refresh_path_from_registry() {
    let query = |root: &str, key: &str| -> Option<String> {
        let mut cmd = command("reg");
        cmd.args(["query", root, "/v", key]);
        let raw = output(cmd, Duration::from_secs(10)).ok()?;
        raw.lines()
            .find(|line| line.trim_start().starts_with(key))
            .and_then(|line| line.split_whitespace().nth(2).map(str::to_string))
    };
    let machine = query(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "Path",
    );
    let user = query("HKCU\\Environment", "Path");
    let mut parts: Vec<String> = env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .map(str::to_string)
        .collect();
    for extra in [machine, user].into_iter().flatten() {
        parts.extend(extra.split(';').map(str::to_string));
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|part| !part.trim().is_empty() && seen.insert(part.to_lowercase()));
    env::set_var("PATH", parts.join(";"));
    forget_caches();
}

#[cfg(not(windows))]
pub fn refresh_path_from_registry() {}

pub fn qemu_system_binary(arch: &str) -> &'static str {
    if arch == "arm64" {
        "qemu-system-aarch64"
    } else {
        "qemu-system-x86_64"
    }
}

/// `-machine`/`-accel`/`-cpu` triplet for `arch`, forcing `accel` when the
/// caller is retrying a VM that failed to start with the preferred one.
pub fn machine_args(cmd: &mut Command, arch: &str, accel: &str) {
    machine_args_tuned(cmd, arch, accel, "other", false);
}

/// Hyper-V enlightenments KVM exposes to a Windows guest. Without them Windows
/// polls timers and spins on locks as on bare metal: the single largest CPU
/// cost of a Windows VM on Linux. QEMU 4.1+ knows every flag listed here.
const KVM_HYPERV_FLAGS: &str = "hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_vpindex,hv_runtime,hv_synic,hv_stimer,hv_time,hv_frequencies,hv_tlbflush,hv_ipi";

/// x86-64-v2 on top of `qemu64`: Windows 11 24H2 refuses to boot without
/// SSE4.2 and POPCNT, which the bare `qemu64` model WHPX is limited to lacks.
const WHPX_V2_FLAGS: &str = "+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,+lahf_lm";

/// Same as `machine_args`, with the per-guest tuning of `tuned` launches:
/// enlightenments and timer settings for Windows, x86-64-v2 on WHPX. A QEMU
/// that refuses one of them gets an untuned retry from the launch ladder.
pub fn machine_args_tuned(cmd: &mut Command, arch: &str, accel: &str, guest_os: &str, tuned: bool) {
    machine_args_for(cmd, arch, accel, guest_os, tuned, "auto", "auto");
}

/// x86 chipsets offered: q35 (PCIe, the default) and i440FX "pc" (PCI + ISA,
/// what DOS, Windows 9x/XP and old Linux expect).
pub const X86_MACHINES: [&str; 3] = ["auto", "q35", "pc"];

/// CPU models offered, by architecture (QEMU names; `auto` keeps Virtua's
/// choice: `host` with KVM/HVF, x86-64-v2 on WHPX, `max` under emulation).
pub const X86_CPUS: [&str; 21] = [
    "auto", "host", "max", "qemu64", "qemu32", "kvm64", "286", "386", "486", "pentium", "pentium2", "pentium3", "pentium4", "athlon",
    "core2duo", "Nehalem", "SandyBridge", "Haswell", "Skylake-Client", "Cascadelake-Server", "EPYC",
];
pub const ARM_CPUS: [&str; 7] = ["auto", "host", "max", "cortex-a53", "cortex-a57", "cortex-a72", "neoverse-n1"];

/// Period CPUs: the QEMU model used and the `-icount` shift giving roughly
/// the speed of the time (2^shift ns per instruction). QEMU has no 286/386
/// model (its oldest is the 486) nor a Pentium 4 (a Pentium III with SSE2).
pub fn vintage_cpu(choice: &str) -> Option<(&'static str, u8)> {
    Some(match choice {
        "286" => ("486", 9),      // ~2 MIPS
        "386" => ("486", 7),      // ~8 MIPS
        "486" => ("486", 4),      // ~60 MIPS (486 DX2/DX4)
        "pentium" => ("pentium", 3),
        "pentium2" => ("pentium2", 2),
        "pentium3" => ("pentium3", 1),
        "pentium4" => ("pentium3,+sse2", 0),
        _ => return None,
    })
}

/// QEMU `-cpu` value of a choice offered in the list.
pub fn qemu_cpu_name(choice: &str) -> &str {
    vintage_cpu(choice).map(|(cpu, _)| cpu).unwrap_or(choice)
}

/// `value` if it is a machine type offered for `arch`, else `auto`.
pub fn normalize_machine(arch: &str, value: Option<&str>) -> String {
    match value {
        Some(m) if arch != "arm64" && X86_MACHINES.contains(&m) => m.to_string(),
        _ => "auto".to_string(),
    }
}

/// `value` if it is a CPU model offered for `arch`, else `auto` (the list is
/// also what keeps a comma or an option out of QEMU's `-cpu`).
pub fn normalize_cpu_model(arch: &str, value: Option<&str>) -> String {
    let allowed: &[&str] = if arch == "arm64" { &ARM_CPUS } else { &X86_CPUS };
    match value {
        Some(m) if allowed.contains(&m) => m.to_string(),
        _ => "auto".to_string(),
    }
}

/// Machine/CPU with the VM's explicit choices (`auto` = Virtua decides).
pub fn machine_args_for(cmd: &mut Command, arch: &str, accel: &str, guest_os: &str, tuned: bool, machine_choice: &str, cpu_choice: &str) {
    let windows = guest_os == "windows";
    let chipset = if machine_choice == "pc" { "pc" } else { "q35" };
    let mut machine = if arch == "arm64" {
        "virt".to_string()
    } else if accel == "whpx" {
        // WHPX cannot drive the in-kernel IRQ chip; without this QEMU aborts
        // with "WHPX: injection failed" as soon as the guest enables MSI.
        format!("{chipset},kernel-irqchip=off")
    } else {
        chipset.to_string()
    };
    if tuned && windows && arch != "arm64" && accel == "kvm" {
        // With hv_stimer/hv_time Windows no longer needs the HPET, whose
        // emulation costs a VM exit per timer read.
        machine.push_str(",hpet=off");
    }
    // Cross-architecture TCG (x86 guest on Apple Silicon) defaults to a single
    // host thread for every vCPU because x86 memory ordering is stronger than
    // ARM's. Multi-threaded TCG is what makes a multi-vCPU x86 guest usable
    // on a Mac; QEMU only prints a warning about it.
    let accel_arg = if accel == "tcg-period" {
        // Period speed: `-icount` needs single-threaded TCG (QEMU refuses MTTCG).
        "tcg,thread=single".to_string()
    } else if accel == "tcg" {
        "tcg,thread=multi".to_string()
    } else {
        accel.to_string()
    };
    let explicit = cpu_choice != "auto" && !cpu_choice.is_empty();
    let cpu = match accel {
        // `host` needs hardware acceleration; under emulation it is `max`.
        _ if explicit && cpu_choice == "host" && accel.starts_with("tcg") => "max".to_string(),
        _ if explicit => qemu_cpu_name(cpu_choice).to_string(),
        "tcg" => "max".to_string(),
        "whpx" if tuned => format!("qemu64,{WHPX_V2_FLAGS},-hypervisor"),
        "whpx" => "qemu64,-hypervisor".to_string(),
        "kvm" if tuned && windows && arch != "arm64" => format!("host,{KVM_HYPERV_FLAGS}"),
        _ => "host".to_string(),
    };
    cmd.args(["-machine", &machine, "-accel", &accel_arg, "-cpu", &cpu]);
}

/// What the host can give a VM, for the UI and for the launch tuning.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    /// `auxinux` on AuxiNux OS, else the os-release ID (`debian`, `ubuntu`…),
    /// `macos` or `windows`.
    pub distro: String,
    pub auxinux: bool,
    /// Why hardware acceleration is unavailable although the host has it
    /// (e.g. /dev/kvm exists but the user is not in the `kvm` group).
    pub acceleration_issue: Option<String>,
}

fn os_release_ids() -> Vec<String> {
    let raw = fs::read_to_string("/etc/os-release")
        .or_else(|_| fs::read_to_string("/usr/lib/os-release"))
        .unwrap_or_default();
    parse_os_release_ids(&raw)
}

/// `ID` then every `ID_LIKE` entry, lower-cased and unquoted.
pub fn parse_os_release_ids(raw: &str) -> Vec<String> {
    let mut ids = vec![];
    for line in raw.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim().trim_matches('"').trim_matches('\'').to_lowercase();
        match key.trim() {
            "ID" => ids.insert(0, value),
            "ID_LIKE" => ids.extend(value.split_whitespace().map(str::to_string)),
            _ => {}
        }
    }
    ids
}

/// AuxiNux OS ships its own kernel (`*-auxinux-*`) on a Debian base; either
/// marker is enough.
pub fn is_auxinux(os_ids: &[String], kernel_release: &str) -> bool {
    os_ids.iter().any(|id| id.contains("auxinux")) || kernel_release.to_lowercase().contains("auxinux")
}

static PROFILE: Mutex<Option<HostProfile>> = Mutex::new(None);

pub fn host_profile() -> HostProfile {
    if let Some(found) = PROFILE.lock().ok().and_then(|cache| cache.clone()) {
        return found;
    }
    let profile = match env::consts::OS {
        "linux" => {
            let ids = os_release_ids();
            let kernel = fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
            let auxinux = is_auxinux(&ids, &kernel);
            let kvm = Path::new("/dev/kvm");
            let acceleration_issue = if !kvm.exists() {
                Some("/dev/kvm absent : activez la virtualisation (VT-x/AMD-V) dans le BIOS/UEFI.".to_string())
            } else if fs::OpenOptions::new().read(true).write(true).open(kvm).is_err() {
                Some("/dev/kvm refusé : votre compte doit faire partie du groupe kvm, sinon les VM tournent en émulation logicielle, dix fois plus lente.".to_string())
            } else {
                None
            };
            HostProfile {
                distro: if auxinux { "auxinux".into() } else { ids.first().cloned().unwrap_or_else(|| "linux".into()) },
                auxinux,
                acceleration_issue,
            }
        }
        os => HostProfile { distro: os.to_string(), auxinux: false, acceleration_issue: None },
    };
    if let Ok(mut cache) = PROFILE.lock() {
        *cache = Some(profile.clone());
    }
    profile
}

/// Accelerators to try, in order, for `arch`: the preferred one first and TCG
/// last so a machine without Hyper-V/KVM/HVF still boots (slowly) instead of
/// reporting a dead VM.
pub fn accelerator_chain(arch: &str) -> Vec<String> {
    let preferred = accelerator(arch);
    if preferred == "tcg" {
        vec!["tcg".to_string()]
    } else {
        vec![preferred, "tcg".to_string()]
    }
}

pub fn firmware(arch: &str) -> Option<String> {
    if arch != "arm64" {
        return None;
    }
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/share/qemu"),
        PathBuf::from("/usr/local/share/qemu"),
        PathBuf::from("/usr/share/qemu"),
        PathBuf::from("/usr/share/AAVMF"),
        PathBuf::from("/usr/share/edk2/aarch64"),
        PathBuf::from("/usr/share/edk2/arm"),
        PathBuf::from("/usr/share/qemu-efi-aarch64"),
    ];
    for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(key).map(PathBuf::from) {
            dirs.extend([root.join("qemu"), root.join("qemu/share")]);
        }
    }
    if let Some(bin) = find_binary(qemu_system_binary(arch)) {
        if let Some(p) = Path::new(&bin).parent() {
            dirs.push(p.to_path_buf());
            dirs.push(p.join("share"));
            dirs.push(p.join("share/qemu"));
            if let Some(prefix) = p.parent() {
                dirs.push(prefix.join("share/qemu"));
            }
        }
    }
    for dir in dirs {
        for file in [
            "edk2-aarch64-code.fd",
            "AAVMF_CODE.fd",
            "AAVMF_CODE.no-secboot.fd",
            "QEMU_EFI.fd",
        ] {
            let path = dir.join(file);
            if path.is_file() {
                return Some(path.to_string_lossy().into());
            }
        }
    }
    None
}
/// The variable-store template shipped next to an EDK2 code image
/// (Homebrew `edk2-arm-vars.fd`, Debian `AAVMF_VARS.fd`).
pub fn firmware_vars_template(code: &str) -> Option<PathBuf> {
    let dir = Path::new(code).parent()?;
    ["edk2-arm-vars.fd", "AAVMF_VARS.fd", "QEMU_VARS.fd"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn logical_cores() -> f32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as f32)
        .unwrap_or(1.0)
}

pub fn terminate(pid: u32) -> Result<(), String> {
    let mut s = sysinfo::System::new();
    s.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
    );
    match s.process(sysinfo::Pid::from_u32(pid)) {
        Some(p) if !p.kill() => Err("Arrêt du processus refusé".into()),
        _ => Ok(()),
    }
}

/// Liveness (QEMU `-name` matching one of the expected names) and CPU/RAM/
/// uptime of several VMs from one process-table pass and two CPU samples.
/// The inventory refresh used to check each VM with up to two full process
/// refreshes, then sample metrics separately: four scans per VM per poll.
pub fn qemu_processes(expected: &[(u32, Vec<String>)]) -> HashMap<u32, (f32, u64, u64)> {
    let mut result = HashMap::new();
    if expected.is_empty() {
        return result;
    }
    let wanted: Vec<sysinfo::Pid> = expected.iter().map(|(p, _)| sysinfo::Pid::from_u32(*p)).collect();
    let mut system = sysinfo::System::new();
    let first = sysinfo::ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_cmd(sysinfo::UpdateKind::OnlyIfNotSet);
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&wanted), true, first);
    let alive: Vec<sysinfo::Pid> = expected
        .iter()
        .filter(|(pid, names)| {
            system.process(sysinfo::Pid::from_u32(*pid)).is_some_and(|process| {
                process.status() != sysinfo::ProcessStatus::Zombie
                    && process.cmd().windows(2).any(|pair| {
                        pair[0] == "-name" && names.iter().any(|name| pair[1] == name.as_str())
                    })
            })
        })
        .map(|(pid, _)| sysinfo::Pid::from_u32(*pid))
        .collect();
    if alive.is_empty() {
        return result;
    }
    // A single sample always reports 0% CPU: sysinfo needs two.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    let second = sysinfo::ProcessRefreshKind::nothing().with_cpu().with_memory();
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&alive), true, second);
    let cores = logical_cores();
    for pid in alive {
        if let Some(process) = system.process(pid) {
            result.insert(
                pid.as_u32(),
                (
                    (process.cpu_usage() / cores).clamp(0.0, 100.0),
                    process.memory(),
                    process.run_time(),
                ),
            );
        }
    }
    result
}

pub fn metrics() -> Result<LocalHostMetrics, String> {
    // CPU and memory only: a full `new_all()` also walked every process of the
    // host (hundreds on a Mac) on each dashboard refresh.
    let mut s = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing()
            .with_cpu(sysinfo::CpuRefreshKind::nothing().with_cpu_usage())
            .with_memory(sysinfo::MemoryRefreshKind::everything()),
    );
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    s.refresh_cpu_usage();
    let mem = s.total_memory();
    let cores = s.cpus().len() as u32;
    let storage = read_storage_config()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|d| Path::new(&storage.disk_dir).starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len());
    Ok(LocalHostMetrics {
        computer_name: sysinfo::System::host_name().unwrap_or_else(|| "Ordinateur local".into()),
        cpu_usage: s.global_cpu_usage(),
        memory_usage: if mem > 0 {
            s.used_memory() as f32 / mem as f32 * 100.0
        } else {
            0.0
        },
        storage_usage: disk
            .filter(|d| d.total_space() > 0)
            .map(|d| (1.0 - d.available_space() as f32 / d.total_space() as f32) * 100.0)
            .unwrap_or(0.0),
        uptime_seconds: Some(sysinfo::System::uptime()),
        total_cores: cores,
        virtualization_cores: cores.saturating_sub(2).max(1),
        total_memory_gib: mem as f32 / 1073741824.0,
        virtualization_memory_gib: (mem as f32 / 2147483648.0).floor().max(1.0),
    })
}
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceleration_matrix() {
        assert_eq!(acceleration("macos", "arm64", "arm64"), "hvf");
        assert_eq!(acceleration("macos", "arm64", "amd64"), "tcg");
        assert_eq!(acceleration("windows", "amd64", "amd64"), "whpx");
        assert_eq!(acceleration("windows", "arm64", "arm64"), "tcg");
        assert_eq!(acceleration("linux", "amd64", "amd64"), "kvm");
    }
    #[test]
    fn shell_arguments_are_literal() {
        assert_eq!(quote("a'b $(x)"), "'a'\\''b $(x)'");
    }
    #[test]
    fn whpx_disables_the_in_kernel_irqchip() {
        let mut cmd = Command::new("qemu");
        machine_args(&mut cmd, "amd64", "whpx");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"q35,kernel-irqchip=off".to_string()));
        assert!(args.contains(&"qemu64,-hypervisor".to_string()));
    }
    #[test]
    fn tcg_runs_one_host_thread_per_vcpu() {
        let mut cmd = Command::new("qemu");
        machine_args(&mut cmd, "amd64", "tcg");
        assert!(cmd.get_args().any(|a| a == "tcg,thread=multi"));
    }
    #[test]
    fn windows_on_kvm_gets_hyperv_enlightenments_only_when_tuned() {
        let args = |tuned: bool, guest: &str, accel: &str| {
            let mut cmd = Command::new("qemu");
            machine_args_tuned(&mut cmd, "amd64", accel, guest, tuned);
            cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>()
        };
        let tuned = args(true, "windows", "kvm");
        assert!(tuned.iter().any(|a| a.starts_with("host,hv_relaxed") && a.contains("hv_stimer")));
        assert!(tuned.contains(&"q35,hpet=off".to_string()));
        assert!(args(false, "windows", "kvm").contains(&"host".to_string()));
        assert!(args(true, "other", "kvm").contains(&"host".to_string()));
        // Windows 11 24H2 needs SSE4.2 + POPCNT, absent from bare qemu64.
        let whpx = args(true, "windows", "whpx");
        assert!(whpx.iter().any(|a| a.contains("+sse4.2") && a.contains("+popcnt") && a.ends_with("-hypervisor")));
        assert!(args(false, "windows", "whpx").contains(&"qemu64,-hypervisor".to_string()));
    }
    #[test]
    fn explicit_machine_and_cpu_choices_are_honoured_and_checked() {
        let args = |machine: &str, cpu: &str, accel: &str| {
            let mut cmd = Command::new("qemu");
            machine_args_for(&mut cmd, "amd64", accel, "other", true, machine, cpu);
            cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>()
        };
        let dos = args("pc", "486", "kvm");
        assert!(dos.contains(&"pc".to_string()) && dos.contains(&"486".to_string()));
        assert!(args("pc", "auto", "whpx").contains(&"pc,kernel-irqchip=off".to_string()));
        assert!(args("auto", "host", "tcg").contains(&"max".to_string()));
        assert!(args("q35", "auto", "kvm").contains(&"host".to_string()));
        assert_eq!(normalize_cpu_model("amd64", Some("486")), "486");
        assert_eq!(normalize_cpu_model("amd64", Some("host,+evil")), "auto");
        assert_eq!(normalize_cpu_model("arm64", Some("486")), "auto");
        assert_eq!(normalize_cpu_model("arm64", Some("cortex-a72")), "cortex-a72");
        assert_eq!(normalize_machine("amd64", Some("pc")), "pc");
        assert_eq!(normalize_machine("arm64", Some("pc")), "auto");
        assert_eq!(normalize_machine("amd64", Some("isapc")), "auto");
    }
    #[test]
    fn period_cpus_map_to_qemu_models_and_speeds() {
        assert_eq!(vintage_cpu("286"), Some(("486", 9)));
        assert_eq!(qemu_cpu_name("pentium4"), "pentium3,+sse2");
        assert_eq!(qemu_cpu_name("Haswell"), "Haswell");
        assert_eq!(normalize_cpu_model("amd64", Some("386")), "386");
        let mut cmd = Command::new("qemu");
        machine_args_for(&mut cmd, "amd64", "tcg-period", "other", false, "pc", "286");
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert!(args.contains(&"tcg,thread=single".to_string()) && args.contains(&"486".to_string()));
    }
    #[test]
    fn auxinux_is_recognised_by_os_release_or_kernel() {
        let ids = parse_os_release_ids("NAME=\"AuxiNux OS\"\nID=auxinux\nID_LIKE=\"debian\"\n");
        assert_eq!(ids, ["auxinux", "debian"]);
        assert!(is_auxinux(&ids, "6.12.0"));
        let debian = parse_os_release_ids("ID=debian\n");
        assert!(is_auxinux(&debian, "7.2.4-auxinux-virtua-amd64"));
        assert!(!is_auxinux(&debian, "6.12.0-amd64"));
    }
    #[test]
    fn tcg_is_always_the_last_resort() {
        assert_eq!(accelerator_chain("nonexistent-arch").last().unwrap(), "tcg");
    }
    #[test]
    fn absolute_binaries_are_used_verbatim() {
        let absolute = if cfg!(windows) {
            "C:\\qemu\\qemu-img.exe"
        } else {
            "/usr/bin/qemu-img"
        };
        assert_eq!(candidates(absolute), vec![PathBuf::from(absolute)]);
    }
    #[test]
    fn search_directories_are_unique() {
        let dirs = search_dirs();
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(dirs.len(), unique.len());
    }
}

pub fn named_qemu_alive(pid: u32, name: &str) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    system
        .process(sysinfo::Pid::from_u32(pid))
        .is_some_and(|process| {
            process.status() != sysinfo::ProcessStatus::Zombie
                && process
                    .cmd()
                    .windows(2)
                    .any(|pair| pair[0] == "-name" && pair[1] == name)
        })
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    #[test]
    fn process_identity_is_loaded_before_checking_qemu_name() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 5; true", "-name", "Virtua-test"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let valid = named_qemu_alive(child.id(), "Virtua-test");
        let wrong = named_qemu_alive(child.id(), "other-vm");
        let _ = child.kill();
        let _ = child.wait();
        assert!(valid);
        assert!(!wrong);
    }
    #[test]
    fn qemu_processes_match_the_name_and_report_metrics() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 3; true", "-name", "Virtua-metrics"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let pid = child.id();
        let found = qemu_processes(&[(pid, vec!["other".into(), "Virtua-metrics".into()])]);
        let wrong = qemu_processes(&[(pid, vec!["other".into()])]);
        let _ = child.kill();
        let _ = child.wait();
        assert!(found.contains_key(&pid));
        assert!(wrong.is_empty());
    }
}
