//! One persistent Debian 13 VM per user. No emulation of an amd64 kernel on ARM.
use super::*;
use sha2::{Digest, Sha512};
use std::io::{Seek, SeekFrom};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    pub architecture: String,
    pub pid: Option<u32>,
    pub ssh_port: u16,
    pub qmp_port: u16,
}
#[cfg(test)]
thread_local! { static TEST_DIRECTORY: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }
fn directory() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = TEST_DIRECTORY.with(|p| p.borrow().clone()) {
        return Ok(path);
    }
    Ok(local_state_dir()?.join("Debian-LXC"))
}
fn state_path() -> Result<PathBuf, String> {
    Ok(directory()?.join("companion.json"))
}
pub fn load() -> Result<Option<Companion>, String> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| format!("Configuration Debian LXC invalide : {e}"))
}
fn save(vm: &Companion) -> Result<(), String> {
    let path = state_path()?;
    let temp = path.with_extension("tmp");
    fs::write(
        &temp,
        serde_json::to_vec_pretty(vm).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Windows rename cannot overwrite. Retain the old file until new content is fully written.
    if cfg!(windows) && path.exists() {
        fs::copy(&temp, &path).map_err(|e| e.to_string())?;
        fs::remove_file(temp).map_err(|e| e.to_string())
    } else {
        fs::rename(temp, path).map_err(|e| e.to_string())
    }
}
fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn keygen(path: &Path) -> Result<(), String> {
    if path.exists() && path.with_extension("pub").exists() {
        return Ok(());
    }
    let mut cmd = platform::command("ssh-keygen");
    cmd.args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(path);
    platform::output(cmd, Duration::from_secs(30)).map(|_| ())
}
pub fn ssh(vm: &Companion, line: &str) -> Result<Command, String> {
    let dir = directory()?;
    let mut cmd = platform::command("ssh");
    cmd.arg("-F")
        .arg(if cfg!(windows) { "NUL" } else { "/dev/null" })
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "HostKeyAlias=virtua-debian-lxc",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "GlobalKnownHostsFile=none",
        ])
        .arg("-o")
        .arg(format!(
            "UserKnownHostsFile={}",
            dir.join("known_hosts").to_string_lossy()
        ))
        .arg("-i")
        .arg(dir.join("client_key"))
        .arg("-p")
        .arg(vm.ssh_port.to_string())
        .arg("virtua@127.0.0.1")
        .arg(line);
    Ok(cmd)
}
fn cloud_config(public: &str, host_private: &str, host_public: &str) -> String {
    // JSON is valid YAML; cloud-init accepts a cloud-config header followed by JSON.
    let script = format!(
        "#!/bin/sh\nset -eu\n{}\ntouch /var/lib/virtua-lxc-ready\n",
        containers::INIT_SCRIPT
    );
    let config = serde_json::json!({
        "hostname":"virtua-lxc", "manage_etc_hosts":true,
        "users":[{"name":"virtua","shell":"/bin/bash","lock_passwd":true,"sudo":"ALL=(ALL) NOPASSWD:ALL","ssh_authorized_keys":[public.trim()]}],
        "ssh_pwauth":false,"disable_root":true,
        "ssh_keys":{"ed25519_private":host_private,"ed25519_public":host_public.trim()},
        "package_update":true,"packages":["incus","incus-client","qemu-guest-agent"],
        "write_files":[{"path":"/usr/local/sbin/virtua-lxc-init","permissions":"0700","owner":"root:root","content":script}],
        "runcmd":[["systemctl","enable","--now","incus"],["/usr/local/sbin/virtua-lxc-init"]]
    });
    format!(
        "#cloud-config\n{}\n",
        serde_json::to_string_pretty(&config).unwrap()
    )
}
fn seed(dir: &Path) -> Result<(), String> {
    keygen(&dir.join("client_key"))?;
    keygen(&dir.join("host_key"))?;
    let public = fs::read_to_string(dir.join("client_key.pub")).map_err(|e| e.to_string())?;
    let host_public = fs::read_to_string(dir.join("host_key.pub")).map_err(|e| e.to_string())?;
    let host_private = fs::read_to_string(dir.join("host_key")).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("known_hosts"),
        format!("virtua-debian-lxc {}\n", host_public.trim()),
    )
    .map_err(|e| e.to_string())?;
    let path = dir.join("seed.img.part");
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.set_len(8 * 1024 * 1024).map_err(|e| e.to_string())?;
    fatfs::format_volume(
        &mut file,
        fatfs::FormatVolumeOptions::new().volume_label(*b"CIDATA     "),
    )
    .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let fat = fatfs::FileSystem::new(file, fatfs::FsOptions::new()).map_err(|e| e.to_string())?;
    let data = cloud_config(&public, &host_private, &host_public);
    {
        let root = fat.root_dir();
        root.create_file("user-data")
            .map_err(|e| e.to_string())?
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        root.create_file("meta-data")
            .map_err(|e| e.to_string())?
            .write_all(b"instance-id: virtua-lxc-v020\nlocal-hostname: virtua-lxc\n")
            .map_err(|e| e.to_string())?;
    }
    fat.unmount().map_err(|e| e.to_string())?;
    fs::rename(&path, dir.join("seed.img")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("seed.img"), fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn checksum(manifest: &str, name: &str) -> Result<String, String> {
    manifest
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let file = parts.next()?.trim_start_matches('*');
            (file == name && hash.len() == 128 && hash.chars().all(|c| c.is_ascii_hexdigit()))
                .then(|| hash.to_lowercase())
        })
        .ok_or_else(|| format!("SHA512 absent pour {name}"))
}
fn download(report: &dyn Fn(&str), dir: &Path, arch: &str) -> Result<(), String> {
    if !matches!(arch, "amd64" | "arm64") {
        return Err("Architecture Debian non prise en charge".into());
    }
    let base = "https://cloud.debian.org/images/cloud/trixie/latest";
    let name = format!("debian-13-generic-{arch}.qcow2");
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?;
    let manifest = client
        .get(format!("{base}/SHA512SUMS"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;
    let expected = checksum(&manifest, &name)?;
    let path = dir.join("debian.qcow2.part");
    report("Téléchargement de l’image officielle Debian 13 et vérification SHA512…");
    let mut response = client
        .get(format!("{base}/{name}"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut hash = Sha512::new();
    let mut buf = [0u8; 65536];
    let mut count = 0u64;
    let mut reported = 0u64;
    loop {
        let n = response.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hash.update(&buf[..n]);
        count += n as u64;
        if count - reported > 32 * 1024 * 1024 {
            report(&format!("Debian 13 : {} Mio téléchargés…", count / 1048576));
            reported = count;
        }
    }
    if format!("{:x}", hash.finalize()) != expected {
        let _ = fs::remove_file(path);
        return Err("Image Debian rejetée : SHA512 incorrect. Réessayez le téléchargement.".into());
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    // Complete disk preparation before publishing it; partial downloads are never booted.
    let mut cmd = platform::command("qemu-img");
    cmd.arg("resize").arg(&path).arg("40G");
    platform::output(cmd, Duration::from_secs(60))?;
    fs::rename(path, dir.join("debian.qcow2")).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("image-source.json"),
        serde_json::json!({"url":format!("{base}/{name}"),"sha512":expected}).to_string(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    prepare_inner(&|message| engines::progress(app, "lxc", message))
}
fn prepare_inner(report: &dyn Fn(&str)) -> Result<(), String> {
    let arch = normalize_arch(env::consts::ARCH);
    if !matches!(arch.as_str(), "amd64" | "arm64") {
        return Err("Architecture du poste non prise en charge".into());
    }
    for binary in ["ssh", "ssh-keygen"] {
        if find_binary(binary).is_none() {
            return Err("OpenSSH client est requis. Sur Windows, activez la fonctionnalité facultative Client OpenSSH, puis réessayez.".into());
        }
    }
    let dir = directory()?;
    private_dir(&dir)?;
    let mut vm = load()?.unwrap_or(Companion {
        architecture: arch.clone(),
        pid: None,
        ssh_port: 0,
        qmp_port: 0,
    });
    if vm.architecture != arch {
        return Err("La VM LXC appartient à une autre architecture. Une migration explicite est nécessaire.".into());
    }
    if !dir.join("debian.qcow2").exists() {
        download(report, &dir, &arch)?;
    }
    if !dir.join("seed.img").exists() {
        seed(&dir)?;
    }
    for name in ["client_key", "host_key.pub", "known_hosts"] {
        if !dir.join(name).is_file() {
            return Err(format!("Identité Debian manquante ({name}). Restaurez-la depuis une sauvegarde; le disque a été conservé."));
        }
    }
    if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
        vm.ssh_port =
            find_free_port_excluding(22022, 22122, &[]).ok_or("Aucun port SSH local disponible")?;
        vm.qmp_port =
            find_free_port_excluding(6100, 6199, &[]).ok_or("Aucun port de contrôle disponible")?;
        let binary = if arch == "arm64" {
            "qemu-system-aarch64"
        } else {
            "qemu-system-x86_64"
        };
        let mut cmd = platform::command(binary);
        let accelerator = platform::accelerator(&arch);
        platform::machine_args(&mut cmd, &arch, &accelerator);
        if arch == "arm64" {
            let firmware = platform::firmware(&arch)
                .ok_or("Firmware ARM64 QEMU absent. Installez le paquet EDK2/AAVMF.")?;
            cmd.arg("-bios").arg(firmware);
        }
        for name in ["debian.qcow2", "seed.img"] {
            if dir.join(name).to_string_lossy().contains(',') {
                return Err("Le chemin des données ne peut pas contenir de virgule.".into());
            }
        }
        cmd.args([
            "-name",
            "Virtua-Debian-LXC",
            "-m",
            "2048",
            "-smp",
            "2",
            "-display",
            "none",
        ])
        .arg("-drive")
        .arg(format!(
            "file={},if=virtio,format=qcow2",
            dir.join("debian.qcow2").to_string_lossy()
        ))
        .arg("-drive")
        .arg(format!(
            "file={},if=virtio,format=raw,readonly=on",
            dir.join("seed.img").to_string_lossy()
        ))
        .arg("-netdev")
        .arg(format!(
            "user,id=net0,hostfwd=tcp:127.0.0.1:{}-:22",
            vm.ssh_port
        ))
        .args(["-device", "virtio-net-pci,netdev=net0"])
        .arg("-qmp")
        .arg(format!("tcp:127.0.0.1:{},server=on,wait=off", vm.qmp_port))
        .arg("-serial")
        .arg(format!("file:{}", dir.join("serial.log").to_string_lossy()));
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("qemu.log"))
            .map_err(|e| e.to_string())?;
        cmd.stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_millis(500));
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "Debian LXC ne démarre pas ({status}) : {}",
                tail_file(&dir.join("qemu.log"), 1800).unwrap_or_default()
            ));
        }
        vm.pid = Some(child.id());
        save(&vm)?;
    }
    report(
        "Démarrage de Debian et installation du moteur LXC. Cela peut prendre plusieurs minutes…",
    );
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(1200) {
        if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
            return Err(
                "La VM Debian s’est arrêtée. Consultez ses journaux dans Configuration.".into(),
            );
        }
        if platform::output(
            ssh(&vm, "test -f /var/lib/virtua-lxc-ready")?,
            Duration::from_secs(8),
        )
        .is_ok()
        {
            return Ok(());
        }
        // A retry can repair package/network failures without recreating the disk.
        if platform::output(
            ssh(&vm, "test -f /var/lib/cloud/instance/boot-finished")?,
            Duration::from_secs(8),
        )
        .is_ok()
        {
            report("Finalisation de la configuration LXC…");
            platform::output(ssh(&vm,"sudo -n sh -ec 'apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y incus incus-client; systemctl enable --now incus; /usr/local/sbin/virtua-lxc-init'")?,Duration::from_secs(900))?;
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    Err("Debian n’est pas prêt après 20 minutes. Les données sont conservées; consultez serial.log puis réessayez.".into())
}
#[tauri::command]
pub async fn local_stop_lxc_vm() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = engines::SetupGuard::acquire()?;
        if cfg!(target_os = "linux") {
            return Err("LXC fonctionne sur l’hôte Linux; aucune VM auxiliaire à arrêter.".into());
        }
        if let Some(mut vm) = load()? {
            if platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
                qmp_execute(vm.qmp_port, "system_powerdown")?;
                for _ in 0..60 {
                    if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
                        vm.pid = None;
                        save(&vm)?;
                        return Ok(());
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
                return Err(
                    "L’arrêt de Debian est toujours en cours. Aucun arrêt forcé n’a été effectué."
                        .into(),
                );
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command(async)]
pub fn local_lxc_logs() -> Result<String, String> {
    let dir = directory()?;
    Ok(format!(
        "QEMU\n{}\n\nDebian\n{}",
        tail_file(&dir.join("qemu.log"), 6000).unwrap_or_default(),
        tail_file(&dir.join("serial.log"), 12000).unwrap_or_default()
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_requires_exact_architecture_and_full_digest() {
        let hash = "a".repeat(128);
        let manifest = format!("{hash}  debian-13-generic-arm64.qcow2\n");
        assert_eq!(
            checksum(&manifest, "debian-13-generic-arm64.qcow2").unwrap(),
            hash
        );
        assert!(checksum(&manifest, "debian-13-generic-amd64.qcow2").is_err());
        assert!(checksum("bad file", "file").is_err());
    }
    #[test]
    fn cloud_config_pins_identity_and_uses_standard_debian_packages() {
        let data = cloud_config("ssh-ed25519 user", "private\nkey", "ssh-ed25519 host");
        let value: serde_json::Value =
            serde_json::from_str(data.strip_prefix("#cloud-config\n").unwrap()).unwrap();
        assert_eq!(value["ssh_pwauth"], false);
        assert_eq!(value["ssh_keys"]["ed25519_private"], "private\nkey");
        assert!(value["packages"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("incus")));
        assert!(!data.contains("amd64"));
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(Some(vm)) = load() {
                let _ = qmp_execute(vm.qmp_port, "quit");
                for _ in 0..30 {
                    if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            TEST_DIRECTORY.with(|p| *p.borrow_mut() = None);
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    #[ignore = "Downloads Debian and boots an isolated QEMU VM; run explicitly on macOS/Windows"]
    fn debian_lxc_lifecycle() {
        if cfg!(target_os = "linux") {
            return;
        }
        let dir = env::temp_dir().join(format!("virtua-020-smoke-{}", random_token()));
        TEST_DIRECTORY.with(|p| *p.borrow_mut() = Some(dir.clone()));
        let _cleanup = Cleanup(dir.clone());
        prepare_inner(&|s| eprintln!("{s}")).expect("Debian bootstrap");
        let vm = load().unwrap().unwrap();
        assert_eq!(vm.architecture, normalize_arch(env::consts::ARCH));
        let os = platform::output(
            ssh(&vm, ". /etc/os-release; printf '%s' \"$VERSION_ID\"").unwrap(),
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(os, "13");
        let args = [
            "launch",
            "images:alpine/3.22",
            "virtua-smoke",
            "--profile",
            "virtua",
        ];
        containers::output(&args).expect("create LXC");
        assert!(containers::list()
            .unwrap()
            .iter()
            .any(|c| c.name == "virtua-smoke" && c.state == "running"));
        assert_eq!(
            containers::output(&["exec", "virtua-smoke", "--", "echo", "console-ok"]).unwrap(),
            "console-ok"
        );
        containers::output(&["stop", "virtua-smoke"]).unwrap();
        let restored = containers::list()
            .unwrap()
            .into_iter()
            .find(|container| container.name == "virtua-smoke")
            .unwrap();
        if restored.state != "running" {
            containers::output(&["start", "virtua-smoke"]).unwrap();
        }
        // Re-enter setup reuses the running VM and disk.
        prepare_inner(&|s| eprintln!("{s}")).unwrap();
        assert_eq!(load().unwrap().unwrap().pid, vm.pid);
        let identity = fs::read(dir.join("client_key.pub")).unwrap();
        qmp_execute(vm.qmp_port, "system_powerdown").unwrap();
        for _ in 0..90 {
            if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        assert!(!platform::named_qemu_alive(
            vm.pid.unwrap_or(0),
            "Virtua-Debian-LXC"
        ));
        prepare_inner(&|s| eprintln!("Redémarrage : {s}")).unwrap();
        assert_eq!(fs::read(dir.join("client_key.pub")).unwrap(), identity);
        let restored = (0..30)
            .find_map(|_| {
                let container = containers::list()
                    .ok()?
                    .into_iter()
                    .find(|candidate| candidate.name == "virtua-smoke")?;
                if container.state == "running" {
                    Some(container)
                } else {
                    std::thread::sleep(Duration::from_secs(1));
                    None
                }
            })
            .expect("the autostarted LXC should become ready after Debian reboots");
        assert_eq!(restored.name, "virtua-smoke");
        assert_eq!(
            containers::output(&["exec", "virtua-smoke", "--", "echo", "after-reboot"]).unwrap(),
            "after-reboot"
        );
        containers::output(&["delete", "virtua-smoke", "--force"]).unwrap();
    }
}
