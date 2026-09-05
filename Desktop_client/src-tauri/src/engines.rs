//! Dependency setup is explicit, serialized and re-checks actual engine readiness.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
static INSTALLING: AtomicBool = AtomicBool::new(false);
pub struct SetupGuard;
impl SetupGuard {
    pub fn acquire() -> Result<Self, String> {
        INSTALLING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "Une préparation est déjà en cours".into())
    }
}
impl Drop for SetupGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: String,
    pub state: String,
    pub detail: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOverview {
    pub os: String,
    pub architecture: String,
    pub accelerator: String,
    pub engines: Vec<EngineStatus>,
    pub busy: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgress<'a> {
    engine: &'a str,
    message: &'a str,
}
pub fn progress(app: &tauri::AppHandle, engine: &str, message: &str) {
    let _ = app.emit("engine-setup-progress", SetupProgress { engine, message });
}
pub fn status(id: &str, state: &str, detail: impl Into<String>) -> EngineStatus {
    EngineStatus {
        id: id.into(),
        state: state.into(),
        detail: detail.into(),
    }
}
pub fn overview() -> Result<EngineOverview, String> {
    let d = qemu_diagnostics_blocking()?;
    let qemu = if d.ready {
        status(
            "qemu",
            "ready",
            "QEMU est disponible pour l’architecture du poste.",
        )
    } else {
        status("qemu", "missing", "QEMU est nécessaire au mode local.")
    };
    let docker = if find_binary("docker").is_none() {
        status(
            "docker",
            "missing",
            "Docker est optionnel. Il sera installé à votre demande.",
        )
    } else {
        match docker::probe(&["info", "--format", "{{.OSType}}"]) {
            Ok(os) if os.trim() == "linux" => {
                status("docker", "ready", "Le moteur Docker Linux répond.")
            }
            Ok(_) => status(
                "docker",
                "unavailable",
                "Basculez Docker Desktop vers les conteneurs Linux.",
            ),
            Err(e) => status(
                "docker",
                "stopped",
                format!("Docker est installé mais inaccessible : {e}"),
            ),
        }
    };
    Ok(EngineOverview {
        os: d.os,
        architecture: d.host_arch,
        accelerator: d.accelerator.unwrap_or_else(|| "tcg".into()),
        engines: vec![qemu, docker, lxc_status()],
        busy: INSTALLING.load(Ordering::SeqCst),
    })
}
fn lxc_status() -> EngineStatus {
    if cfg!(target_os = "linux") {
        if find_binary("incus").is_none() {
            return status(
                "lxc",
                "missing",
                "Installer le moteur LXC (Incus) sur cet hôte Linux.",
            );
        }
        return match containers::probe() {
            Ok(_) => status(
                "lxc",
                "ready",
                "LXC fonctionne directement sur l’hôte, via Incus.",
            ),
            Err(e) => status(
                "lxc",
                "stopped",
                format!("Incus doit être préparé ou autorisé : {e}"),
            ),
        };
    }
    match companion::load() {
        Ok(Some(vm)) => {
            if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
                return status(
                    "lxc",
                    "stopped",
                    "La VM Debian 13 est arrêtée. Démarrez-la pour retrouver vos LXC.",
                );
            }
            match containers::probe() {
                Ok(_) => status(
                    "lxc",
                    "ready",
                    format!(
                        "VM Debian 13 {} active — noyau Debian standard.",
                        vm.architecture
                    ),
                ),
                Err(e) => status(
                    "lxc",
                    "stopped",
                    format!("La VM démarre ou nécessite une réparation : {e}"),
                ),
            }
        }
        Ok(None) => status(
            "lxc",
            "missing",
            "Préparer une VM Debian 13 dédiée : 2 vCPU, 2 Gio RAM et disque extensible de 40 Gio.",
        ),
        Err(e) => status("lxc", "unavailable", e),
    }
}
#[tauri::command]
pub async fn local_engine_status() -> Result<EngineOverview, String> {
    tauri::async_runtime::spawn_blocking(overview)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn local_prepare_engine(
    app: tauri::AppHandle,
    engine: String,
) -> Result<EngineOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SetupGuard::acquire()?;
        progress(&app, &engine, "Vérification de l’installation existante…");
        match engine.as_str() {
            "qemu" => install_qemu(&app)?,
            "docker" => install_docker(&app)?,
            "lxc" if cfg!(target_os = "linux") => install_incus(&app)?,
            "lxc" => {
                install_qemu(&app)?;
                ensure_ssh(&app)?;
                companion::prepare(&app)?;
            }
            _ => return Err("Moteur inconnu".into()),
        }
        progress(&app, &engine, "Vérification du moteur…");
        drop(_guard);
        overview()
    })
    .await
    .map_err(|e| e.to_string())?
}
/// macOS setup runs in Terminal so Homebrew/sudo can present their own prompts.
fn mac_script(script: &str) -> Result<(), String> {
    let dir = local_state_dir()?.join("Setup");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = random_token();
    let path = dir.join(format!("{id}.sh"));
    let result = dir.join(format!("{id}.exit"));
    let body=format!("#!/bin/bash\nexport PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH\n(\nset -e\n{script}\n)\ncode=$?\nprintf '%s' \"$code\" > {}\necho \"Virtua Desktop : opération terminée ($code). Vous pouvez fermer ce terminal.\"\nexit \"$code\"\n",platform::quote(&result.to_string_lossy()));
    fs::write(&path, body).map_err(|e| e.to_string())?;
    let invocation = format!("/bin/bash {}", platform::quote(&path.to_string_lossy()));
    let apple = serde_json::to_string(&invocation).map_err(|e| e.to_string())?;
    platform::probe(
        "osascript",
        &[
            "-e",
            &format!("tell application \"Terminal\"\nactivate\ndo script {apple}\nend tell"),
        ],
    )?;
    let start = std::time::Instant::now();
    loop {
        if let Ok(code) = fs::read_to_string(&result) {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&result);
            return if code.trim() == "0" {
                Ok(())
            } else {
                Err(
                    "L’installation a échoué ou a été annulée. Consultez le terminal et réessayez."
                        .into(),
                )
            };
        }
        if start.elapsed() > Duration::from_secs(3600) {
            return Err("Installation toujours en attente dans Terminal. Terminez-la puis actualisez le diagnostic.".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
fn linux_script(script: &str) -> Result<(), String> {
    let mut cmd = if platform::probe("id", &["-u"]).as_deref() == Ok("0") {
        platform::command("sh")
    } else {
        if find_binary("pkexec").is_none() {
            return Err(
                "Installez polkit (pkexec) pour permettre l’installation depuis le client.".into(),
            );
        }
        let mut c = platform::command("pkexec");
        c.arg("/bin/sh");
        c
    };
    cmd.args(["-ec", script]);
    platform::output(cmd, Duration::from_secs(3600)).map(|_| ())
}
fn winget(id: &str) -> Result<(), String> {
    if find_binary("winget").is_none() {
        return Err(
            "Installez App Installer (winget) depuis Microsoft Store, puis relancez Virtua.".into(),
        );
    }
    let mut cmd = platform::command("winget");
    cmd.args([
        "install",
        "--id",
        id,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]);
    platform::output(cmd, Duration::from_secs(3600)).map(|_| ())
}
fn brew_prefix() -> &'static str {
    "if ! command -v brew >/dev/null 2>&1; then\n /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o \"${TMPDIR:-/tmp}/virtua-homebrew-install.sh\"\n /bin/bash \"${TMPDIR:-/tmp}/virtua-homebrew-install.sh\"\nfi\n"
}
pub fn install_qemu(app: &tauri::AppHandle) -> Result<(), String> {
    if qemu_diagnostics_blocking()?.ready {
        return Ok(());
    }
    progress(
        app,
        "qemu",
        "Installation de QEMU. Le système peut demander une autorisation administrateur.",
    );
    match env::consts::OS {
        "macos" => mac_script(&format!("{}\nbrew install qemu", brew_prefix()))?,
        "windows" => winget("SoftwareFreedomConservancy.QEMU")?,
        "linux" => linux_script(if find_binary("apt-get").is_some() {
            "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y qemu-system-x86 qemu-system-arm qemu-utils qemu-efi-aarch64 ovmf"
        } else if find_binary("dnf").is_some() {
            "dnf install -y qemu-system-x86 qemu-system-aarch64 qemu-img edk2-aarch64 edk2-ovmf"
        } else if find_binary("pacman").is_some() {
            "pacman -S --needed --noconfirm qemu-full edk2-aarch64 edk2-ovmf"
        } else {
            return Err("Distribution non prise en charge par l’installation automatique. Installez QEMU via votre gestionnaire de paquets, puis actualisez.".into());
        })?,
        _ => return Err("Système non pris en charge".into()),
    }
    if !qemu_diagnostics_blocking()?.ready {
        return Err(
            "QEMU reste introuvable ou incompatible. Relancez Virtua si le PATH a changé.".into(),
        );
    }
    Ok(())
}
fn install_docker(app: &tauri::AppHandle) -> Result<(), String> {
    if find_binary("docker").is_some() {
        docker::endpoint()?;
    }
    if docker::probe(&["info", "--format", "{{.OSType}}"]).as_deref() == Ok("linux") {
        return Ok(());
    }
    progress(
        app,
        "docker",
        "Préparation de Docker. Terminez l’assistant Docker Desktop s’il s’ouvre.",
    );
    match env::consts::OS {
        "macos" => {
            if !Path::new("/Applications/Docker.app").exists() && find_binary("docker").is_none() {
                mac_script(&format!("{}\nbrew install --cask docker", brew_prefix()))?;
            }
            platform::probe("open", &["-a", "Docker"])?;
        }
        "windows" => {
            if find_binary("docker").is_none() {
                winget("Docker.DockerDesktop")?;
            }
            let path = PathBuf::from(
                env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into()),
            )
            .join("Docker/Docker/Docker Desktop.exe");
            Command::new(path).spawn().map_err(|e| e.to_string())?;
        }
        "linux" => {
            let user = platform::probe("id", &["-un"])?;
            let install = if find_binary("docker").is_some() {
                ""
            } else if find_binary("apt-get").is_some() {
                "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y docker.io\n"
            } else if find_binary("dnf").is_some() {
                "dnf install -y moby-engine\n"
            } else if find_binary("pacman").is_some() {
                "pacman -S --needed --noconfirm docker\n"
            } else {
                return Err(
                    "Installez Docker Engine via votre distribution, puis actualisez.".into(),
                );
            };
            linux_script(&format!(
                "{install}systemctl enable --now docker\nusermod -aG docker {}",
                platform::quote(&user)
            ))?;
            if docker::probe(&["info"]).is_err() {
                return Err("Docker est installé. Fermez votre session Linux puis reconnectez-vous pour activer les droits du groupe docker.".into());
            }
        }
        _ => return Err("Système non pris en charge".into()),
    }
    for _ in 0..60 {
        if docker::probe(&["info", "--format", "{{.OSType}}"]).as_deref() == Ok("linux") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err("Docker ne répond pas encore. Terminez son assistant (et le redémarrage Windows si demandé), puis actualisez.".into())
}
fn install_incus(app: &tauri::AppHandle) -> Result<(), String> {
    if containers::probe().is_ok() {
        return Ok(());
    }
    if !Path::new("/proc/self/ns/user").exists() || !Path::new("/sys/fs/cgroup").exists() {
        return Err("Le noyau hôte doit fournir les namespaces utilisateur et les cgroups.".into());
    }
    progress(
        app,
        "lxc",
        "Installation de LXC via Incus sur l’hôte Linux.",
    );
    let user = platform::probe("id", &["-un"])?;
    let install = if find_binary("incus").is_some() {
        ""
    } else if find_binary("apt-get").is_some() {
        "apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y incus incus-client\n"
    } else if find_binary("dnf").is_some() {
        "dnf install -y incus\n"
    } else if find_binary("pacman").is_some() {
        "pacman -S --needed --noconfirm incus\n"
    } else {
        return Err("Installez Incus via votre distribution, puis actualisez.".into());
    };
    linux_script(&format!(
        "{install}systemctl enable --now incus\nusermod -aG incus-admin {}\n{}",
        platform::quote(&user),
        containers::INIT_SCRIPT
    ))?;
    if containers::probe().is_err() {
        return Err("Incus est préparé. Fermez votre session Linux puis reconnectez-vous pour activer les droits incus-admin.".into());
    }
    Ok(())
}

fn ensure_ssh(app: &tauri::AppHandle) -> Result<(), String> {
    if find_binary("ssh").is_some() && find_binary("ssh-keygen").is_some() {
        return Ok(());
    }
    if !cfg!(windows) {
        return Err("Installez le client OpenSSH, puis réessayez.".into());
    }
    progress(
        app,
        "lxc",
        "Activation du client OpenSSH de Windows. Acceptez la demande administrateur.",
    );
    let script = "$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile -Command \"$ErrorActionPreference = ''Stop''; try { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0; exit 0 } catch { exit 1 }\"'; exit $p.ExitCode";
    let mut cmd = platform::command("powershell");
    cmd.args(["-NoProfile", "-Command", script]);
    platform::output(cmd, Duration::from_secs(900))?;
    if find_binary("ssh").is_none() || find_binary("ssh-keygen").is_none() {
        return Err(
            "OpenSSH reste indisponible. Redémarrez Windows si demandé, puis réessayez.".into(),
        );
    }
    Ok(())
}
