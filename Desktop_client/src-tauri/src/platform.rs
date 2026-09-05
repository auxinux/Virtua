//! Platform-specific paths, process execution and QEMU acceleration.
use super::*;

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
pub fn candidates(binary: &str) -> Vec<PathBuf> {
    let name = if cfg!(windows) && !binary.ends_with(".exe") {
        format!("{binary}.exe")
    } else {
        binary.into()
    };
    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/usr/sbin",
            "/bin",
            "/sbin",
            "/Applications/Docker.app/Contents/Resources/bin",
        ]
        .map(PathBuf::from),
    );
    if let Some(p) = env::var_os("ProgramFiles") {
        let p = PathBuf::from(p);
        dirs.extend([p.join("qemu"), p.join("Docker/Docker/resources/bin")]);
    }
    if let Some(p) = env::var_os("SystemRoot") {
        let p = PathBuf::from(p);
        dirs.extend([
            p.join("System32/OpenSSH"),
            p.join("System32/WindowsPowerShell/v1.0"),
            p.join("System32"),
        ]);
    }
    if let Ok(home) = home() {
        dirs.push(home.join("AppData/Local/Microsoft/WindowsApps"));
    }
    dirs.into_iter().map(|p| p.join(&name)).collect()
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
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
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
pub fn accelerator(guest: &str) -> String {
    let desired = acceleration(env::consts::OS, &normalize_arch(env::consts::ARCH), guest);
    if desired == "kvm"
        && fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/kvm")
            .is_err()
    {
        return "tcg".into();
    }
    let binary = if guest == "arm64" {
        "qemu-system-aarch64"
    } else {
        "qemu-system-x86_64"
    };
    match probe(binary, &["-accel", "help"]) {
        Ok(list) if list.lines().any(|s| s.trim() == desired) => desired.into(),
        _ => "tcg".into(),
    }
}
pub fn machine_args(cmd: &mut Command, arch: &str) {
    let accel = accelerator(arch);
    cmd.args([
        "-machine",
        if arch == "arm64" { "virt" } else { "q35" },
        "-accel",
        &accel,
        "-cpu",
        if accel == "tcg" {
            "max"
        } else if accel == "whpx" {
            "qemu64"
        } else {
            "host"
        },
    ]);
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
    ];
    if let Some(bin) = find_binary("qemu-system-aarch64") {
        if let Some(p) = Path::new(&bin).parent() {
            dirs.push(p.to_path_buf());
            dirs.push(p.join("share"));
        }
    }
    for dir in dirs {
        for file in ["edk2-aarch64-code.fd", "AAVMF_CODE.fd", "QEMU_EFI.fd"] {
            let path = dir.join(file);
            if path.is_file() {
                return Some(path.to_string_lossy().into());
            }
        }
    }
    None
}
pub fn alive(pid: u32) -> bool {
    let mut s = sysinfo::System::new();
    s.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
    );
    s.process(sysinfo::Pid::from_u32(pid))
        .is_some_and(|p| p.status() != sysinfo::ProcessStatus::Zombie)
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
}
