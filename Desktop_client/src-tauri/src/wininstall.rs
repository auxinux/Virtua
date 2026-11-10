//! Windows engine installs without a package manager.
//!
//! Many Windows machines cannot use winget (blocked by policy, App Installer
//! missing, Store disabled — error 0x80070001 and friends). Virtua then
//! downloads the official installers itself, checks them and runs them
//! silently; Windows shows its single administrator prompt (UAC).
//! - QEMU: the builds qemu.org points to (qemu.weilnetz.de/w64), each
//!   published with its SHA-512.
//! - Docker Desktop: Docker's own installer (signed by Docker; no checksum
//!   file is published next to it).
use super::*;
use engines::{overview, progress, EngineOverview};
use sha2::{Digest, Sha512};

/// PowerShell single-quoted literal ('' is the only escape there).
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub const QEMU_W64_BASE: &str = "https://qemu.weilnetz.de/w64/";
pub const DOCKER_DESKTOP_URL: &str = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";

/// Newest `qemu-w64-setup-YYYYMMDD.exe` of the directory listing.
pub fn latest_qemu_installer(listing: &str) -> Option<String> {
    listing
        .split("href=\"")
        .skip(1)
        .filter_map(|chunk| chunk.split('"').next())
        .filter(|name| {
            name.strip_prefix("qemu-w64-setup-")
                .and_then(|rest| rest.strip_suffix(".exe"))
                .is_some_and(|date| date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()))
        })
        .max()
        .map(str::to_string)
}

/// Hash of `file` in a `.sha512` file (`<hash>  <name>`, or the bare hash).
pub fn sha512_for(content: &str, file: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?.to_lowercase();
        let name = parts.next().map(|n| n.trim_start_matches('*'));
        (hash.len() == 128 && hash.chars().all(|c| c.is_ascii_hexdigit()) && name.is_none_or(|n| n == file)).then_some(hash)
    })
}

fn sha512_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha512::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Run an installer elevated (UAC) and wait for it. Exit code 1223 / a
/// refused prompt means the user (or policy) declined the elevation.
fn run_elevated(exe: &Path, arguments: &str) -> Result<(), String> {
    let script = format!(
        "try {{ $p = Start-Process -FilePath {} -ArgumentList {} -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode }} catch {{ exit 1223 }}",
        ps_quote(&exe.to_string_lossy()),
        ps_quote(arguments)
    );
    let mut cmd = platform::command("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    match platform::output(cmd, Duration::from_secs(1800)) {
        Ok(_) => Ok(()),
        Err(error) if error.contains("1223") || error.trim().is_empty() => Err(
            "L’autorisation administrateur a été refusée ou n’est pas disponible sur ce compte.".into(),
        ),
        Err(error) => Err(format!("L’installateur a échoué : {error}")),
    }
}

fn setup_dir() -> Result<PathBuf, String> {
    let dir = local_state_dir()?.join("Setup");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn install_qemu_direct(app: &tauri::AppHandle) -> Result<(), String> {
    progress(app, "qemu", "winget indisponible : téléchargement de l’installateur officiel de QEMU (qemu.weilnetz.de)…");
    let client = http_client(Duration::from_secs(60))?;
    let listing = client
        .get(QEMU_W64_BASE)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Site de QEMU pour Windows inaccessible ({QEMU_W64_BASE}) : {e}"))?;
    let exe = latest_qemu_installer(&listing).ok_or("Aucun installateur QEMU trouvé sur qemu.weilnetz.de")?;
    let sums_name = exe.replace(".exe", ".sha512");
    let sums = client
        .get(format!("{QEMU_W64_BASE}{sums_name}"))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Somme de contrôle de {exe} inaccessible : {e}"))?;
    let expected = sha512_for(&sums, &exe).ok_or_else(|| format!("Somme de contrôle de {exe} illisible"))?;
    let destination = setup_dir()?.join(&exe);
    if !destination.is_file() || sha512_file(&destination)? != expected {
        download_file_with_progress(app, "qemu-installer", &exe, &format!("{QEMU_W64_BASE}{exe}"), &destination)?;
    }
    if sha512_file(&destination)? != expected {
        let _ = fs::remove_file(&destination);
        return Err(format!("{exe} est corrompu (SHA-512 différent) : réessayez."));
    }
    progress(app, "qemu", "Installation de QEMU : acceptez la demande d’autorisation de Windows.");
    // NSIS: /S = silent; default folder C:\Program Files\qemu, already searched.
    run_elevated(&destination, "/S")?;
    let _ = fs::remove_file(&destination);
    Ok(())
}

pub fn install_docker_direct(app: &tauri::AppHandle) -> Result<(), String> {
    progress(app, "docker", "winget indisponible : téléchargement de Docker Desktop depuis docker.com…");
    let destination = setup_dir()?.join("Docker Desktop Installer.exe");
    download_file_with_progress(app, "docker-installer", "Docker Desktop Installer.exe", DOCKER_DESKTOP_URL, &destination)?;
    progress(app, "docker", "Installation de Docker Desktop : acceptez la demande d’autorisation de Windows.");
    run_elevated(&destination, "install --quiet --accept-license")?;
    let _ = fs::remove_file(&destination);
    Ok(())
}

/// `dir` (or its `bin` folder) holds QEMU: qemu-img and a qemu-system.
pub fn qemu_folder(dir: &Path) -> Option<PathBuf> {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    [dir.to_path_buf(), dir.join("bin")].into_iter().find(|candidate| {
        candidate.join(format!("qemu-img{exe}")).is_file()
            && (candidate.join(format!("qemu-system-x86_64{exe}")).is_file()
                || candidate.join(format!("qemu-system-aarch64{exe}")).is_file())
    })
}

/// "I already have QEMU": a folder chosen by the user (portable build,
/// installed by IT, …), searched before the usual places.
#[tauri::command]
pub async fn local_set_qemu_dir(path: String) -> Result<EngineOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = qemu_folder(Path::new(path.trim()))
            .ok_or("Ce dossier ne contient pas QEMU (qemu-img et qemu-system-x86_64 ou qemu-system-aarch64).")?;
        platform::add_tool_dir(&folder)?;
        forget_diagnostics();
        overview()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_literals_escape_quotes_their_way() {
        assert_eq!(ps_quote("C:\\Users\\O'Neil\\x.exe"), "'C:\\Users\\O''Neil\\x.exe'");
    }

    #[test]
    fn the_newest_official_installer_is_picked() {
        let listing = r#"<a href="qemu-w64-setup-20260729.exe">x</a> <a href="qemu-w64-setup-20260811.exe">y</a>
            <a href="qemu-w64-setup-20260811.sha512">s</a> <a href="qemu-w64-setup-2026.exe">bad</a> <a href="2026/">d</a>"#;
        assert_eq!(latest_qemu_installer(listing).as_deref(), Some("qemu-w64-setup-20260811.exe"));
        assert_eq!(latest_qemu_installer("nothing"), None);
    }

    #[test]
    fn sha512_files_are_read_with_or_without_a_name() {
        let hash = "5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543";
        assert_eq!(sha512_for(&format!("{hash}  qemu-w64-setup-20260811.exe\n"), "qemu-w64-setup-20260811.exe").as_deref(), Some(hash));
        assert_eq!(sha512_for(hash, "x.exe").as_deref(), Some(hash));
        assert_eq!(sha512_for(&format!("{hash}  other.exe"), "x.exe"), None);
    }

    #[test]
    fn a_qemu_folder_is_recognised_directly_or_through_bin() {
        let root = std::env::temp_dir().join(format!("virtua-qemu-dir-{}", random_token()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let exe = if cfg!(windows) { ".exe" } else { "" };
        assert!(qemu_folder(&root).is_none());
        fs::write(bin.join(format!("qemu-img{exe}")), b"").unwrap();
        fs::write(bin.join(format!("qemu-system-x86_64{exe}")), b"").unwrap();
        assert_eq!(qemu_folder(&root), Some(bin));
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn the_official_site_has_a_checked_installer() {
        let client = crate::http_client(std::time::Duration::from_secs(30)).unwrap();
        let listing = client.get(super::QEMU_W64_BASE).send().unwrap().text().unwrap();
        let exe = super::latest_qemu_installer(&listing).unwrap();
        let sums = client.get(format!("{}{}", super::QEMU_W64_BASE, exe.replace(".exe", ".sha512"))).send().unwrap().text().unwrap();
        println!("{exe} sha512={:?}", super::sha512_for(&sums, &exe).map(|h| h[..16].to_string()));
    }
}
