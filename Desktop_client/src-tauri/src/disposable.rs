//! Disposable VMs: a ready system in seconds, kept or thrown away afterwards.
//!
//! A *base* is an installed, generalized system stored read-only in
//! `Local/Bases/<id>/` (`manifest.json`, `disk.qcow2`, UEFI variable stores,
//! TPM state). A disposable VM is a copy-on-write overlay on that disk — a few
//! KiB, created instantly; several disposables can share one base.
//!
//! - Windows bases are built on this computer (quick create, then kept as a
//!   base): an installed Windows is not ours to redistribute.
//! - Debian bases can also come from the AuxiNux depot as `.vmtmp` files
//!   (`TEMPLATES/VM/<arch>/`): a plain tar of the base directory.
//! - When a disposable stops, the user throws it away, starts over from the
//!   base, keeps it as is, or converts it into an ordinary VM.
//! - Strict sandbox: QEMU `-snapshot`, nothing at all is written to disk.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseManifest {
    pub id: String,
    pub label: String,
    /// `windows11`, `debian13`…
    pub os: String,
    pub architecture: String,
    pub guest_os: String,
    pub cpu: u16,
    pub memory_mib: u32,
    pub disk_gib: u32,
    #[serde(default = "default_disk_bus")]
    pub disk_bus: String,
    #[serde(default = "default_network_model")]
    pub network_model: String,
    #[serde(default = "default_gpu_model")]
    pub gpu_model: String,
    #[serde(default)]
    pub tpm2: bool,
    #[serde(default)]
    pub secure_boot: bool,
    pub created_at: String,
    /// `local` (built here) or `depot`.
    #[serde(default)]
    pub source: String,
    /// sha256 of `disk.qcow2`, checked on import.
    #[serde(default)]
    pub disk_sha256: Option<String>,
    /// Format version of the `.vmtmp` / base directory.
    #[serde(default = "format_version")]
    pub format: u32,
}

fn format_version() -> u32 {
    1
}

/// Disposable state stored on the VM.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Disposable {
    pub base_id: String,
    pub base_label: String,
    /// Strict sandbox: QEMU `-snapshot`, the overlay itself stays untouched.
    #[serde(default)]
    pub strict: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseInfo {
    #[serde(flatten)]
    pub manifest: BaseManifest,
    pub size: u64,
    /// Disposable VMs currently built on this base.
    pub in_use: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotBase {
    pub name: String,
    pub url: String,
    pub size: Option<u64>,
}

fn bases_dir() -> Result<PathBuf, String> {
    let dir = local_state_dir()?.join("Bases");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn base_dir(id: &str) -> Result<PathBuf, String> {
    Ok(bases_dir()?.join(safe_file_name(id)?))
}

fn read_manifest(dir: &Path) -> Result<BaseManifest, String> {
    let raw = fs::read_to_string(dir.join("manifest.json")).map_err(|e| format!("Base illisible : {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("manifest.json invalide : {e}"))
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

/// Files next to a VM disk that belong to it (UEFI variable stores): base
/// `disk.<suffix>` ↔ VM `<disk stem>.<suffix>`.
fn companion_files(disk: &Path) -> Vec<(PathBuf, String)> {
    let Some(dir) = disk.parent() else { return vec![] };
    let Some(stem) = disk.file_stem().map(|s| s.to_string_lossy().to_string()) else { return vec![] };
    fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().to_string();
            let suffix = name.strip_prefix(&format!("{stem}."))?.to_string();
            (suffix.ends_with(".fd") && path.is_file()).then_some((path, suffix))
        })
        .collect()
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn qemu_img() -> Result<String, String> {
    find_binary("qemu-img").ok_or_else(|| "qemu-img introuvable : préparez QEMU dans Configuration.".to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn os_label(os: &str) -> &'static str {
    match os {
        "windows11" => "Windows 11",
        "debian13" => "Debian 13",
        _ => "Système",
    }
}

// ── Bases ───────────────────────────────────────────────────────────────────

pub fn list_bases() -> Result<Vec<BaseInfo>, String> {
    let vms = {
        let _guard = inventory_guard();
        read_local_vms()?
    };
    let mut bases: Vec<BaseInfo> = fs::read_dir(bases_dir()?)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.path().join("disk.qcow2").is_file())
        .filter_map(|entry| {
            let manifest = read_manifest(&entry.path()).ok()?;
            let in_use = vms.iter().filter(|vm| vm.disposable.as_ref().is_some_and(|d| d.base_id == manifest.id)).count();
            Some(BaseInfo { size: dir_size(&entry.path()), in_use, manifest })
        })
        .collect();
    bases.sort_by(|a, b| a.manifest.label.to_lowercase().cmp(&b.manifest.label.to_lowercase()));
    Ok(bases)
}

/// Make a base out of a stopped VM (flattened copy of its disk, UEFI stores
/// and TPM state). `remove_source`: the VM was only built for this.
pub fn base_from_vm(vm_id: &str, os: Option<&str>, remove_source: bool) -> Result<BaseManifest, String> {
    let vm = {
        let _guard = inventory_guard();
        read_local_vms()?.into_iter().find(|vm| vm.id == vm_id).ok_or("VM locale introuvable")?
    };
    if vm.state != "stopped" || vm.pid.is_some() {
        return Err(format!("Arrêtez « {} » avant d’en faire une base.", vm.name));
    }
    if vm.disposable.is_some() {
        return Err("Une VM jetable ne peut pas servir de base : convertissez-la d’abord en VM normale.".into());
    }
    let os = os.map(str::to_string).unwrap_or_else(|| {
        if vm.guest_os == "windows" { "windows11".into() } else { "debian13".into() }
    });
    let id = format!("{}-{}-{}", os, vm.architecture, now_id());
    let dir = base_dir(&id)?;
    let partial = dir.with_extension("partial");
    let _ = fs::remove_dir_all(&partial);
    fs::create_dir_all(&partial).map_err(|e| e.to_string())?;
    let result = (|| -> Result<BaseManifest, String> {
        // `convert` flattens any backing chain and drops unused clusters.
        let mut convert = platform::command(&qemu_img()?);
        convert.args(["convert", "-O", "qcow2"]).arg(&vm.disk_path).arg(partial.join("disk.qcow2"));
        platform::output(convert, Duration::from_secs(4 * 3600)).map_err(|e| format!("Copie du disque impossible : {e}"))?;
        for (path, suffix) in companion_files(Path::new(&vm.disk_path)) {
            fs::copy(&path, partial.join(format!("disk.{suffix}"))).map_err(|e| e.to_string())?;
        }
        if let Ok(tpm) = tpm_state_dir(&vm.id) {
            if tpm.is_dir() {
                copy_dir(&tpm, &partial.join("tpm"))?;
            }
        }
        let manifest = BaseManifest {
            id: id.clone(),
            label: format!("{} ({})", os_label(&os), vm.architecture.to_uppercase()),
            os: os.clone(),
            architecture: vm.architecture.clone(),
            guest_os: vm.guest_os.clone(),
            cpu: vm.cpu,
            memory_mib: vm.memory_mib,
            disk_gib: vm.disk_gib,
            disk_bus: vm.disk_bus.clone(),
            network_model: vm.network_model.clone(),
            gpu_model: vm.gpu_model.clone(),
            tpm2: vm.tpm2,
            secure_boot: vm.secure_boot,
            created_at: now_string(),
            source: "local".into(),
            disk_sha256: None,
            format: 1,
        };
        write_json_atomic(&partial.join("manifest.json"), &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)?;
        Ok(manifest)
    })();
    match result {
        Ok(manifest) => {
            fs::rename(&partial, &dir).map_err(|e| e.to_string())?;
            if remove_source {
                let _guard = inventory_guard();
                let _ = local_delete_vm_blocking(vm.id.clone(), true);
            }
            Ok(manifest)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&partial);
            Err(error)
        }
    }
}

pub fn delete_base(id: &str) -> Result<(), String> {
    let in_use = {
        let _guard = inventory_guard();
        read_local_vms()?.iter().filter(|vm| vm.disposable.as_ref().is_some_and(|d| d.base_id == id)).count()
    };
    if in_use > 0 {
        return Err(format!("{in_use} VM jetable(s) utilisent encore cette base : jetez-les ou convertissez-les d’abord."));
    }
    let dir = base_dir(id)?;
    if !is_path_inside(&dir, &bases_dir()?) {
        return Err("Base invalide".into());
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Suppression impossible : {e}"))
}

// ── .vmtmp files ────────────────────────────────────────────────────────────

/// Pack a base as `<label>.vmtmp` in the export folder (tar; the disk is
/// compressed inside the qcow2 so it stays usable as a backing file).
pub fn export_base(id: &str) -> Result<String, String> {
    let dir = base_dir(id)?;
    let mut manifest = read_manifest(&dir)?;
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let scratch = PathBuf::from(&config.export_dir).join(format!(".{}-export", safe_file_name(id)?));
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let _cleanup = ScratchDirGuard(scratch.clone());
    let mut convert = platform::command(&qemu_img()?);
    convert.args(["convert", "-c", "-O", "qcow2"]).arg(dir.join("disk.qcow2")).arg(scratch.join("disk.qcow2"));
    platform::output(convert, Duration::from_secs(4 * 3600)).map_err(|e| format!("Compression du disque impossible : {e}"))?;
    manifest.disk_sha256 = Some(sha256_file(&scratch.join("disk.qcow2"))?);
    manifest.source = "depot".into();
    let name = format!("{}-{}.vmtmp", manifest.os, manifest.architecture);
    let out = PathBuf::from(&config.export_dir).join(&name);
    let file = fs::File::create(&out).map_err(|e| e.to_string())?;
    let mut tar = tar::Builder::new(file);
    let manifest_raw = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_raw.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "manifest.json", manifest_raw.as_slice()).map_err(|e| e.to_string())?;
    tar.append_path_with_name(scratch.join("disk.qcow2"), "disk.qcow2").map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("disk.") && name.ends_with(".fd") {
            tar.append_path_with_name(entry.path(), &name).map_err(|e| e.to_string())?;
        }
    }
    // The TPM state stays on this computer: a shared TPM identity is not what
    // a new copy wants.
    tar.finish().map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

struct ScratchDirGuard(PathBuf);
impl Drop for ScratchDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Unpack a `.vmtmp` into the bases (checked: safe paths, manifest, sha256).
pub fn import_vmtmp(file: &Path) -> Result<BaseManifest, String> {
    let staging = bases_dir()?.join(format!(".import-{}", now_id()));
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let _cleanup = ScratchDirGuard(staging.clone());
    let mut archive = tar::Archive::new(fs::File::open(file).map_err(|e| e.to_string())?);
    for entry in archive.entries().map_err(|e| format!("Fichier .vmtmp illisible : {e}"))? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
        let name = path.to_string_lossy().to_string();
        let allowed = name == "manifest.json" || name == "disk.qcow2" || (name.starts_with("disk.") && name.ends_with(".fd") && !name.contains('/'));
        if !allowed || !tar_entry_is_safe(&path) {
            continue;
        }
        entry.unpack(staging.join(&name)).map_err(|e| e.to_string())?;
    }
    let mut manifest = read_manifest(&staging)?;
    if !staging.join("disk.qcow2").is_file() {
        return Err("Le fichier .vmtmp ne contient pas de disque".into());
    }
    if let Some(expected) = &manifest.disk_sha256 {
        if &sha256_file(&staging.join("disk.qcow2"))? != expected {
            return Err("Le disque du .vmtmp est corrompu (somme de contrôle)".into());
        }
    }
    let host = normalize_arch(env::consts::ARCH);
    if manifest.architecture != host {
        return Err(format!("Base {} : cet ordinateur est {}.", manifest.architecture, host));
    }
    manifest.id = format!("{}-{}-{}", manifest.os, manifest.architecture, now_id());
    manifest.source = "depot".into();
    write_json_atomic(&staging.join("manifest.json"), &serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)?;
    fs::rename(&staging, base_dir(&manifest.id)?).map_err(|e| e.to_string())?;
    Ok(manifest)
}

/// `.vmtmp` files of the depot for this computer's architecture.
pub fn depot_bases() -> Result<Vec<DepotBase>, String> {
    let base = repository_url("VM", &normalize_arch(env::consts::ARCH))?;
    let client = http_client(Duration::from_secs(30))?;
    let listing = client
        .get(&base)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| format!("Dépôt AuxiNux inaccessible : {e}"))?;
    Ok(listing
        .split("href=\"")
        .skip(1)
        .filter_map(|chunk| chunk.split('"').next())
        .filter(|name| name.to_lowercase().ends_with(".vmtmp") && !name.contains('/'))
        .map(|name| {
            let name = html_unescape(name);
            let url = format!("{base}{name}");
            let size = client.head(&url).send().ok().and_then(|r| quickcreate::header_length(&r));
            DepotBase { name, url, size }
        })
        .collect())
}

pub fn download_base(app: &tauri::AppHandle, name: &str, url: &str) -> Result<BaseManifest, String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let file = PathBuf::from(&config.export_dir).join(safe_download_name(name)?);
    download_file_with_progress(app, &format!("vmtmp-{name}"), name, url, &file)?;
    let manifest = import_vmtmp(&file);
    // The archive is only a carrier: the base now lives in Local/Bases.
    let _ = fs::remove_file(&file);
    manifest
}

// ── Disposable VMs ──────────────────────────────────────────────────────────

fn new_overlay(base_disk: &Path, overlay: &Path) -> Result<(), String> {
    let mut create = platform::command(&qemu_img()?);
    create
        .args(["create", "-f", "qcow2", "-F", "qcow2", "-b"])
        .arg(base_disk)
        .arg(overlay);
    platform::output(create, Duration::from_secs(60)).map(|_| ()).map_err(|e| format!("Disque jetable impossible : {e}"))
}

/// Base UEFI stores and TPM state → this VM (fresh copies each time).
fn seed_from_base(dir: &Path, vm: &LocalVm) -> Result<(), String> {
    let disk = Path::new(&vm.disk_path);
    let stem = disk.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let parent = disk.parent().ok_or("Disque invalide")?;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(suffix) = name.strip_prefix("disk.").filter(|s| s.ends_with(".fd")) {
            fs::copy(entry.path(), parent.join(format!("{stem}.{suffix}"))).map_err(|e| e.to_string())?;
        }
    }
    let tpm = tpm_state_dir(&vm.id)?;
    let _ = fs::remove_dir_all(&tpm);
    if dir.join("tpm").is_dir() {
        copy_dir(&dir.join("tpm"), &tpm)?;
    }
    Ok(())
}

pub fn launch(base_id: &str, strict: bool, network: &str) -> Result<LocalVm, String> {
    let dir = base_dir(base_id)?;
    let manifest = read_manifest(&dir)?;
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let id = now_id();
    let overlay = PathBuf::from(&config.disk_dir).join(format!("jetable-{}-{id}.qcow2", safe_file_name(&manifest.os)?));
    validate_qemu_path(&overlay.to_string_lossy(), "de disque")?;
    validate_qemu_path(&dir.join("disk.qcow2").to_string_lossy(), "de base")?;
    new_overlay(&dir.join("disk.qcow2"), &overlay)?;

    let vm = {
        let _guard = inventory_guard();
        let mut vms = read_local_vms()?;
        let number = (1..).find(|n| !vms.iter().any(|vm| vm.name == format!("Jetable {} #{n}", os_label(&manifest.os)))).unwrap_or(1);
        let mut vm = new_local_vm(
            id.clone(),
            format!("Jetable {} #{number}", os_label(&manifest.os)),
            &manifest.architecture,
            manifest.cpu,
            manifest.memory_mib,
            manifest.disk_gib,
            overlay.to_string_lossy().to_string(),
            &manifest.guest_os,
        );
        vm.disk_bus = manifest.disk_bus.clone();
        vm.network_model = manifest.network_model.clone();
        vm.gpu_model = manifest.gpu_model.clone();
        vm.network = normalize_network_mode(Some(network.to_string()));
        vm.tpm2 = manifest.tpm2;
        vm.secure_boot = manifest.secure_boot;
        vm.windows_setup_bypass = false;
        vm.disposable = Some(Disposable { base_id: manifest.id.clone(), base_label: manifest.label.clone(), strict });
        if manifest.guest_os == "windows" {
            vm.unified = true;
            vm.unified_user = Some(quickcreate::USER.into());
        }
        seed_from_base(&dir, &vm)?;
        vms.push(vm.clone());
        write_local_vms(&vms)?;
        vm
    };
    if manifest.guest_os == "windows" {
        let _ = unified::remember_password(&vm.id, quickcreate::PASSWORD);
    }
    let _guard = inventory_guard();
    run_vm_action(&vm.id, "start")
}

/// `discard` | `reset` | `convert` | `keep` on a stopped disposable VM.
pub fn act(vm_id: &str, action: &str) -> Result<Option<LocalVm>, String> {
    let _guard = inventory_guard();
    let mut vms = read_local_vms()?;
    let index = vms.iter().position(|vm| vm.id == vm_id).ok_or("VM locale introuvable")?;
    let vm = vms[index].clone();
    let disposable = vm.disposable.clone().ok_or("Cette VM n’est pas jetable")?;
    if action == "keep" {
        return Ok(Some(vm));
    }
    if action != "discard" && vm_process_alive(&vm) {
        return Err("Arrêtez la VM d’abord.".into());
    }
    match action {
        "discard" => {
            drop(vms);
            local_delete_vm_blocking(vm_id.to_string(), true)?;
            Ok(None)
        }
        "reset" => {
            let dir = base_dir(&disposable.base_id)?;
            let _ = fs::remove_file(&vm.disk_path);
            new_overlay(&dir.join("disk.qcow2"), Path::new(&vm.disk_path))?;
            seed_from_base(&dir, &vm)?;
            vms[index].updated_at = now_string();
            write_local_vms(&vms)?;
            Ok(Some(vms[index].clone()))
        }
        "convert" => {
            let config = read_storage_config()?;
            let name = vm.name.replacen("Jetable ", "", 1);
            let target = PathBuf::from(&config.disk_dir).join(format!("{}-{}.qcow2", safe_file_name(&name)?, now_id()));
            let mut convert = platform::command(&qemu_img()?);
            convert.args(["convert", "-O", "qcow2"]).arg(&vm.disk_path).arg(&target);
            platform::output(convert, Duration::from_secs(4 * 3600)).map_err(|e| format!("Conversion impossible : {e}"))?;
            // Move the UEFI stores along with the disk, then drop the overlay.
            for (path, suffix) in companion_files(Path::new(&vm.disk_path)) {
                let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let _ = fs::rename(&path, target.with_file_name(format!("{stem}.{suffix}")));
            }
            let _ = fs::remove_file(&vm.disk_path);
            let entry = &mut vms[index];
            entry.disk_path = target.to_string_lossy().to_string();
            entry.disposable = None;
            entry.name = name;
            entry.updated_at = now_string();
            let converted = entry.clone();
            write_local_vms(&vms)?;
            Ok(Some(converted))
        }
        _ => Err("Action inconnue".into()),
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_list_bases() -> Result<Vec<BaseInfo>, String> {
    blocking(list_bases).await
}

#[tauri::command]
pub async fn local_depot_bases() -> Result<Vec<DepotBase>, String> {
    blocking(depot_bases).await
}

#[tauri::command]
pub async fn local_download_base(app: tauri::AppHandle, name: String, url: String) -> Result<BaseManifest, String> {
    blocking(move || download_base(&app, &name, &url)).await
}

#[tauri::command]
pub async fn local_import_base_file(path: String) -> Result<BaseManifest, String> {
    blocking(move || import_vmtmp(Path::new(&path))).await
}

#[tauri::command]
pub async fn local_export_base(id: String) -> Result<String, String> {
    blocking(move || export_base(&id)).await
}

#[tauri::command]
pub async fn local_delete_base(id: String) -> Result<(), String> {
    blocking(move || delete_base(&id)).await
}

#[tauri::command]
pub async fn local_base_from_vm(vm_id: String) -> Result<BaseManifest, String> {
    blocking(move || base_from_vm(&vm_id, None, false)).await
}

/// Build a base on this computer: quick create, then the installed system is
/// kept as a base (and the builder VM removed) by the inventory refresh.
#[tauri::command]
pub async fn local_prepare_base(app: tauri::AppHandle, os: String) -> Result<LocalVm, String> {
    blocking(move || quickcreate::quick_create_base(&app, &os)).await
}

#[tauri::command]
pub async fn local_launch_disposable(base_id: String, strict: bool, network: Option<String>) -> Result<LocalVm, String> {
    blocking(move || launch(&base_id, strict, network.as_deref().unwrap_or("user"))).await
}

#[tauri::command]
pub async fn local_disposable_action(id: String, action: String) -> Result<Option<LocalVm>, String> {
    blocking(move || act(&id, &action)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_round_trip_and_fill_defaults() {
        let raw = r#"{"id":"debian13-amd64-1","label":"Debian 13 (AMD64)","os":"debian13","architecture":"amd64",
            "guestOs":"other","cpu":2,"memoryMib":4096,"diskGib":60,"createdAt":"0"}"#;
        let manifest: BaseManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(manifest.disk_bus, "virtio");
        assert_eq!(manifest.format, 1);
        assert!(!manifest.tpm2);
        let again: BaseManifest = serde_json::from_str(&serde_json::to_string(&manifest).unwrap()).unwrap();
        assert_eq!(again, manifest);
    }

    #[test]
    fn uefi_stores_follow_the_disk_name() {
        let dir = std::env::temp_dir().join(format!("virtua-companion-{}", random_token()));
        fs::create_dir_all(&dir).unwrap();
        let disk = dir.join("win-1.qcow2");
        fs::write(&disk, b"").unwrap();
        fs::write(dir.join("win-1.secboot-vars.fd"), b"vars").unwrap();
        fs::write(dir.join("win-10.secboot-vars.fd"), b"other vm").unwrap();
        fs::write(dir.join("win-1.notes.txt"), b"").unwrap();
        let found = companion_files(&disk);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, "secboot-vars.fd");
        let _ = fs::remove_dir_all(&dir);
    }
}
