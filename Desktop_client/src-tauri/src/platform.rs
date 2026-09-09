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
    if let Ok(mut cache) = BINARIES.lock() {
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
    let machine = if arch == "arm64" {
        "virt".to_string()
    } else if accel == "whpx" {
        // WHPX cannot drive the in-kernel IRQ chip; without this QEMU aborts
        // with "WHPX: injection failed" as soon as the guest enables MSI.
        "q35,kernel-irqchip=off".to_string()
    } else {
        "q35".to_string()
    };
    cmd.args([
        "-machine",
        &machine,
        "-accel",
        accel,
        "-cpu",
        match accel {
            "tcg" => "max",
            "whpx" => "qemu64,-hypervisor",
            _ => "host",
        },
    ]);
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

/// Live CPU/RAM/uptime for several processes in one refresh. The previous
/// implementation shelled out to `ps` once per VM on every poll: absent on
/// Windows, and a process storm on macOS/Linux.
pub fn process_metrics(pids: &[u32]) -> HashMap<u32, (f32, u64, u64)> {
    let mut result = HashMap::new();
    if pids.is_empty() {
        return result;
    }
    let wanted: Vec<sysinfo::Pid> = pids.iter().map(|p| sysinfo::Pid::from_u32(*p)).collect();
    let mut system = sysinfo::System::new();
    let refresh = sysinfo::ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory();
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&wanted), true, refresh);
    // A single sample always reports 0% CPU: sysinfo needs two.
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&wanted), true, refresh);
    let cores = sysinfo::System::new_all().cpus().len().max(1) as f32;
    for pid in pids {
        if let Some(process) = system.process(sysinfo::Pid::from_u32(*pid)) {
            result.insert(
                *pid,
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
    let mut s = sysinfo::System::new_all();
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
    fn process_metrics_report_a_live_child() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 3"])
            .spawn()
            .unwrap();
        let metrics = process_metrics(&[child.id()]);
        let _ = child.kill();
        let _ = child.wait();
        assert!(metrics.contains_key(&child.id()));
    }
}
