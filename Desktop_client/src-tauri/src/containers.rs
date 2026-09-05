//! LXC containers managed through Incus, on Linux or inside the Debian companion.
use super::*;
// Dedicated names avoid changing an existing default profile or storage pool.
pub const INIT_SCRIPT: &str = r#"
export INCUS_REMOTE=local INCUS_PROJECT=default
incus storage show virtua >/dev/null 2>&1 || incus storage create virtua dir
incus network show virtuabr0 >/dev/null 2>&1 || incus network create virtuabr0 ipv4.address=auto ipv4.nat=true ipv6.address=none
if ! incus profile show virtua >/dev/null 2>&1; then
  incus profile create virtua
fi
incus profile device get virtua root path >/dev/null 2>&1 || incus profile device add virtua root disk path=/ pool=virtua
incus profile device get virtua eth0 network >/dev/null 2>&1 || incus profile device add virtua eth0 nic network=virtuabr0 name=eth0
"#;
pub fn command(args: &[&str]) -> Result<Command, String> {
    if cfg!(target_os = "linux") {
        let binary =
            find_binary("incus").ok_or("Activez LXC dans Configuration pour installer Incus.")?;
        let mut cmd = platform::command(&binary);
        // Never follow the user's default remote Incus server in local mode.
        cmd.env("INCUS_REMOTE", "local")
            .env("INCUS_PROJECT", "default")
            .args(args);
        Ok(cmd)
    } else {
        let vm =
            companion::load()?.ok_or("Activez LXC dans Configuration pour préparer Debian 13.")?;
        if !platform::named_qemu_alive(vm.pid.unwrap_or(0), "Virtua-Debian-LXC") {
            return Err("La VM Debian LXC est arrêtée. Démarrez-la dans Configuration.".into());
        }
        let line = format!(
            "sudo -n env INCUS_REMOTE=local INCUS_PROJECT=default incus {}",
            args.iter()
                .map(|s| platform::quote(s))
                .collect::<Vec<_>>()
                .join(" ")
        );
        companion::ssh(&vm, &line)
    }
}
pub fn output(args: &[&str]) -> Result<String, String> {
    platform::output(command(args)?, Duration::from_secs(900))
}
pub fn probe() -> Result<String, String> {
    platform::output(
        command(&["profile", "show", "virtua"])?,
        Duration::from_secs(8),
    )
}
pub fn list() -> Result<Vec<LocalContainerResource>, String> {
    let raw = platform::output(
        command(&["list", "--format", "json", "type=container"])?,
        Duration::from_secs(8),
    )?;
    let items: Vec<serde_json::Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(items
        .iter()
        .filter_map(|v| {
            let name = v.get("name")?.as_str()?;
            let config = &v["expanded_config"];
            Some(LocalContainerResource {
                id: format!("lxc:{name}"),
                kind: "lxc".into(),
                name: name.into(),
                image: config["image.description"].as_str().map(str::to_string),
                state: normalize_container_state(v["status"].as_str().unwrap_or("stopped")),
                ip: None,
                ports: None,
                cpu_usage: None,
                memory_usage: None,
                uptime_seconds: None,
            })
        })
        .collect())
}
pub fn create(payload: LocalCreateContainerPayload) -> Result<LocalContainerResource, String> {
    let name = safe_container_name(&payload.name)?;
    let image = payload.image.unwrap_or_else(|| "images:debian/13".into());
    if image.starts_with('-') || image.trim().is_empty() {
        return Err("Image LXC invalide".into());
    }
    // The directory storage driver has no per-volume quota. Never pretend to enforce one.
    if payload.disk_gib.unwrap_or(0) > 0 {
        return Err("Le stockage LXC partagé ne fournit pas de quota disque individuel. Utilisez une limite de 0 (partagé).".into());
    }
    let mut args = vec![
        "launch".into(),
        image,
        name.clone(),
        "--profile".into(),
        "virtua".into(),
        "-c".into(),
        format!("boot.autostart={}", payload.autostart.unwrap_or(false)),
        "-c".into(),
        format!("security.nesting={}", payload.nesting.unwrap_or(false)),
        "-c".into(),
        format!(
            "security.privileged={}",
            payload.privileged.unwrap_or(false)
        ),
    ];
    if let Some(cpu) = payload.cpu.filter(|v| *v > 0) {
        args.extend(["-c".into(), format!("limits.cpu={cpu}")]);
    }
    if let Some(mem) = payload.memory_mib.filter(|v| *v > 0) {
        args.extend(["-c".into(), format!("limits.memory={mem}MiB")]);
    }
    output(&args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if let Some(password) = payload.root_password.filter(|s| !s.is_empty()) {
        if password.contains(['\n', '\r']) {
            return Err("Mot de passe invalide. Le conteneur a été créé.".into());
        }
        let mut cmd = command(&["exec", &name, "--", "chpasswd"])?;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child
            .stdin
            .take()
            .ok_or("Entrée indisponible")?
            .write_all(format!("root:{password}\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "Conteneur créé; mot de passe non configuré : {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    list()?
        .into_iter()
        .find(|r| r.name == name)
        .ok_or("Conteneur créé mais inventaire indisponible".into())
}
