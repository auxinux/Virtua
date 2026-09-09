mod companion;
mod containers;
mod docker;
mod engines;
mod platform;

const KEYCHAIN_SERVICE: &str = "ca.auxinux.virtua.desktop";
const REFRESH_TOKEN_ACCOUNT: &str = "desktop-refresh-token";
const ENDPOINT_ACCOUNT: &str = "desktop-endpoint";
const DEVICE_NAME_ACCOUNT: &str = "desktop-device-name";
const INSTALLATION_ID_ACCOUNT: &str = "desktop-installation-id";

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBinaryStatus {
    path: Option<String>,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalQemuDiagnostics {
    os: String,
    host_arch: String,
    accelerator: Option<String>,
    qemu_img: LocalBinaryStatus,
    qemu_system_arm64: LocalBinaryStatus,
    qemu_system_amd64: LocalBinaryStatus,
    homebrew: LocalBinaryStatus,
    ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHostMetrics {
    computer_name: String,
    cpu_usage: f32,
    memory_usage: f32,
    storage_usage: f32,
    uptime_seconds: Option<u64>,
    total_cores: u32,
    virtualization_cores: u32,
    total_memory_gib: f32,
    virtualization_memory_gib: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStorageFile {
    name: String,
    path: String,
    size: u64,
    modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDockerImage {
    repository: String,
    tag: String,
    image_id: String,
    size: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStorageInventory {
    iso: Vec<LocalStorageFile>,
    templates: Vec<LocalStorageFile>,
    disks: Vec<LocalStorageFile>,
    snapshots: Vec<LocalStorageFile>,
    exports: Vec<LocalStorageFile>,
    docker_images: Vec<LocalDockerImage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalContainerResource {
    id: String,
    kind: String,
    name: String,
    image: Option<String>,
    state: String,
    ip: Option<String>,
    ports: Option<String>,
    cpu_usage: Option<f32>,
    memory_usage: Option<f32>,
    uptime_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCreateContainerPayload {
    kind: String,
    name: String,
    image: Option<String>,
    cpu: Option<u16>,
    memory_mib: Option<u32>,
    disk_gib: Option<u32>,
    network: Option<String>,
    restart_policy: Option<String>,
    ports: Option<String>,
    privileged: Option<bool>,
    nesting: Option<bool>,
    autostart: Option<bool>,
    root_password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTemplateItem {
    category: String,
    architecture: String,
    name: String,
    url: String,
    size: Option<String>,
    modified_at: Option<String>,
    display_name: Option<String>,
    description: Option<String>,
    cpu: Option<u16>,
    ram: Option<u32>,
    disk: Option<String>,
    metadata_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
struct TemplateMetadata {
    #[serde(default, rename = "Name", alias = "name")]
    name: Option<String>,
    #[serde(
        default,
        rename = "Desc",
        alias = "desc",
        alias = "description",
        alias = "Description"
    )]
    desc: Option<String>,
    #[serde(default, rename = "CPU", alias = "cpu")]
    cpu: Option<u16>,
    #[serde(default, rename = "RAM", alias = "ram")]
    ram: Option<u32>,
    #[serde(default, rename = "DISK", alias = "disk")]
    disk: Option<String>,
    #[serde(
        default,
        rename = "ARCH",
        alias = "arch",
        alias = "architecture",
        alias = "Architecture"
    )]
    arch: Option<String>,
    #[serde(default, rename = "TPM2", alias = "tpm2", alias = "Tpm2")]
    tpm2: Option<bool>,
    #[serde(
        default,
        rename = "SECUREBOOT",
        alias = "secureBoot",
        alias = "secure_boot",
        alias = "SecureBoot"
    )]
    secure_boot: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    id: String,
    name: String,
    received: u64,
    total: Option<u64>,
    progress: Option<f32>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTemplateRequest {
    category: String,
    architecture: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadTemplatePayload {
    category: String,
    architecture: String,
    name: String,
    url: String,
    metadata_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportTemplatePayload {
    vm_id: String,
    template_name: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportTemplatePayload {
    template_path: String,
    architecture: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteStorageFilePayload {
    kind: String,
    path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalSnapshot {
    id: String,
    vm_id: String,
    name: String,
    path: String,
    size: u64,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSnapshotPayload {
    vm_id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotActionPayload {
    vm_id: String,
    snapshot_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalStorageConfig {
    vm_config_dir: String,
    disk_dir: String,
    iso_dir: String,
    snapshot_dir: String,
    export_dir: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalVm {
    id: String,
    name: String,
    architecture: String,
    cpu: u16,
    memory_mib: u32,
    disk_gib: u32,
    disk_path: String,
    iso_path: Option<String>,
    network: String,
    #[serde(default = "default_network_model")]
    network_model: String,
    #[serde(default = "default_gpu_model")]
    gpu_model: String,
    #[serde(default = "default_disk_bus")]
    disk_bus: String,
    #[serde(default)]
    tpm2: bool,
    #[serde(default)]
    secure_boot: bool,
    state: String,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    vnc_port: Option<u16>,
    #[serde(default)]
    spice_port: Option<u16>,
    #[serde(default)]
    spice_password: Option<String>,
    #[serde(default)]
    qmp_port: Option<u16>,
    #[serde(default)]
    qga_port: Option<u16>,
    #[serde(default)]
    guest_ip: Option<String>,
    #[serde(default)]
    guest_agent_running: bool,
    #[serde(default)]
    qga_last_probe_at: Option<u64>,
    #[serde(default)]
    cpu_usage: Option<f32>,
    #[serde(default)]
    memory_usage: Option<f32>,
    #[serde(default)]
    uptime_seconds: Option<u64>,
    /// What the last start had to give up on (acceleration, SPICE, audio…) so
    /// the UI can explain a degraded VM instead of leaving the user guessing.
    #[serde(default)]
    startup_notes: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCreateVmPayload {
    name: String,
    architecture: String,
    cpu: u16,
    memory_mib: u32,
    disk_gib: u32,
    iso_path: Option<String>,
    network: Option<String>,
    network_model: Option<String>,
    gpu_model: Option<String>,
    disk_bus: Option<String>,
    tpm2: Option<bool>,
    secure_boot: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalUpdateVmPayload {
    name: Option<String>,
    image: Option<String>,
    cpu: Option<u16>,
    memory_mib: Option<u32>,
    network: Option<String>,
    network_model: Option<String>,
    gpu_model: Option<String>,
    disk_bus: Option<String>,
    tpm2: Option<bool>,
    secure_boot: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePlatform {
    os: String,
    arch: String,
    mobile: bool,
}

fn account_for_key(key: &str) -> Result<&'static str, String> {
    match key {
        "endpoint" => Ok(ENDPOINT_ACCOUNT),
        "deviceName" => Ok(DEVICE_NAME_ACCOUNT),
        "installationId" => Ok(INSTALLATION_ID_ACCOUNT),
        _ => Err("invalid setting key".to_string()),
    }
}

fn app_support_dir() -> Result<PathBuf, String> {
    platform::data_dir()
}

fn local_state_dir() -> Result<PathBuf, String> {
    Ok(app_support_dir()?.join("Local"))
}

fn default_storage_config() -> Result<LocalStorageConfig, String> {
    let root = local_state_dir()?;
    Ok(LocalStorageConfig {
        vm_config_dir: root.join("VMs").to_string_lossy().to_string(),
        disk_dir: root.join("Disks").to_string_lossy().to_string(),
        iso_dir: root.join("ISOs").to_string_lossy().to_string(),
        snapshot_dir: root.join("Snapshots").to_string_lossy().to_string(),
        export_dir: root.join("Exports").to_string_lossy().to_string(),
    })
}

fn storage_config_path() -> Result<PathBuf, String> {
    Ok(local_state_dir()?.join("storage.json"))
}

fn inventory_path() -> Result<PathBuf, String> {
    Ok(local_state_dir()?.join("local-vms.json"))
}

fn snapshots_index_path() -> Result<PathBuf, String> {
    Ok(local_state_dir()?.join("snapshots.json"))
}

fn template_cache_dir() -> Result<PathBuf, String> {
    Ok(local_state_dir()?.join("Templates"))
}

fn now_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn now_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("local-vm-{}", nanos)
}

fn normalize_arch(arch: &str) -> String {
    match arch {
        "aarch64" | "arm64" => "arm64".to_string(),
        "x86_64" | "amd64" => "amd64".to_string(),
        other => other.to_string(),
    }
}

fn default_network_model() -> String {
    "virtio".to_string()
}

fn default_gpu_model() -> String {
    "virtio".to_string()
}

fn default_disk_bus() -> String {
    "virtio".to_string()
}

fn normalize_disk_bus(architecture: &str, value: Option<String>) -> String {
    // The `virt` machine has no AHCI controller: ARM64 guests are always virtio.
    if architecture == "arm64" {
        return "virtio".to_string();
    }
    match value.unwrap_or_else(default_disk_bus).as_str() {
        "sata" | "ide" | "ahci" => "sata".to_string(),
        _ => "virtio".to_string(),
    }
}

/// Fresh x86 VMs installed from an ISO get a SATA disk: no mainstream OS
/// installer ships virtio-blk drivers, and "no disk found" was the single most
/// common way a local VM looked broken. Templates keep their virtio disk.
fn default_disk_bus_for_new_vm(architecture: &str, iso_path: Option<&str>) -> String {
    if architecture != "arm64" && iso_path.map(|p| !p.trim().is_empty()).unwrap_or(false) {
        return "sata".to_string();
    }
    "virtio".to_string()
}

fn normalize_network_mode(value: Option<String>) -> String {
    match value.unwrap_or_else(|| "user".to_string()).as_str() {
        "isolated" => "isolated".to_string(),
        "vmnet-shared" => "vmnet-shared".to_string(),
        "vmnet-bridged" => "vmnet-bridged".to_string(),
        "user" | "nat" | "" => "user".to_string(),
        other => other.to_string(),
    }
}

fn normalize_network_model(value: Option<String>) -> String {
    match value.unwrap_or_else(default_network_model).as_str() {
        "e1000" => "e1000".to_string(),
        "rtl8139" => "rtl8139".to_string(),
        _ => "virtio".to_string(),
    }
}

fn normalize_gpu_model(value: Option<String>) -> String {
    match value.unwrap_or_else(default_gpu_model).as_str() {
        "std" => "std".to_string(),
        "qxl" => "qxl".to_string(),
        "cirrus" => "cirrus".to_string(),
        _ => "virtio".to_string(),
    }
}

fn effective_network_model(architecture: &str, model: &str) -> String {
    let normalized = normalize_network_model(Some(model.to_string()));
    if architecture == "amd64" && normalized == "virtio" {
        // Les invités x86 émulés sont plus fiables avec e1000 pendant l'installation
        // et avec plusieurs templates qui ne montent pas automatiquement virtio-net-pci.
        return "e1000".to_string();
    }
    normalized
}

fn append_gpu_args(command: &mut Command, architecture: &str, gpu_model: &str) {
    let device = match normalize_gpu_model(Some(gpu_model.to_string())).as_str() {
        "std" if architecture == "arm64" => "ramfb",
        "std" => "VGA",
        "qxl" => "qxl-vga",
        "cirrus" => "cirrus-vga",
        _ if architecture == "arm64" => "virtio-gpu-pci",
        _ => "virtio-vga",
    };
    command.arg("-device").arg(device);
}

fn append_disk_args(command: &mut Command, disk_path: &str, disk_bus: &str) {
    if disk_bus == "sata" {
        command.arg("-drive").arg(format!(
            "file={},if=none,id=virtua-disk0,format=qcow2,cache=writeback,discard=unmap",
            disk_path
        ));
        command
            .arg("-device")
            .arg("ich9-ahci,id=virtua-ahci")
            .arg("-device")
            .arg("ide-hd,drive=virtua-disk0,bus=virtua-ahci.0,bootindex=1");
        return;
    }
    command.arg("-drive").arg(format!(
        "file={},if=virtio,format=qcow2,cache=writeback,discard=unmap",
        disk_path
    ));
}

fn append_network_args(command: &mut Command, architecture: &str, mode: &str, model: &str) {
    let mode = normalize_network_mode(Some(mode.to_string()));
    if mode == "isolated" {
        return;
    }

    let netdev = match mode.as_str() {
        "vmnet-shared" if env::consts::OS == "macos" => "vmnet-shared,id=net0".to_string(),
        "vmnet-bridged" if env::consts::OS == "macos" => {
            "vmnet-bridged,id=net0,ifname=en0".to_string()
        }
        _ => "user,id=net0".to_string(),
    };
    command.arg("-netdev").arg(netdev);

    let effective_model = effective_network_model(architecture, model);
    let device = match effective_model.as_str() {
        "e1000" => "e1000,netdev=net0",
        "rtl8139" => "rtl8139,netdev=net0",
        _ if architecture == "arm64" => "virtio-net-device,netdev=net0",
        _ => "virtio-net-pci,netdev=net0",
    };
    command.arg("-device").arg(device);
}

fn find_binary(binary: &str) -> Option<String> {
    platform::resolve(binary)
}

fn find_free_port_excluding(start: u16, end: u16, reserved: &[u16]) -> Option<u16> {
    (start..=end)
        .filter(|port| !reserved.contains(port))
        .find(|port| std::net::TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

fn tail_file(path: &Path, max_bytes: usize) -> Option<String> {
    let raw = fs::read(path).ok()?;
    let start = raw.len().saturating_sub(max_bytes);
    Some(String::from_utf8_lossy(&raw[start..]).trim().to_string())
}

fn qmp_execute(port: u16, execute: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|err| format!("Connexion QMP impossible: {}", err))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(800)))
        .map_err(|err| err.to_string())?;

    let mut buffer = [0_u8; 4096];
    let _ = stream.read(&mut buffer);

    stream
        .write_all(br#"{"execute":"qmp_capabilities"}"#)
        .and_then(|_| stream.write_all(b"\r\n"))
        .map_err(|err| format!("QMP capabilities impossible: {}", err))?;
    let _ = stream.read(&mut buffer);

    let command = format!(r#"{{"execute":"{}"}}"#, execute);
    stream
        .write_all(command.as_bytes())
        .and_then(|_| stream.write_all(b"\r\n"))
        .map_err(|err| format!("Commande QMP impossible: {}", err))?;
    Ok(())
}

/// The guest agent is reached over a loopback TCP chardev rather than a Unix
/// socket: QEMU on Windows cannot serve `socket,path=…`, so the previous
/// implementation silently disabled the agent (and therefore guest IPs) there.
fn qga_execute(port: u16, execute: &str) -> Result<serde_json::Value, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(600))
        .map_err(|err| format!("Connexion QEMU guest agent impossible: {}", err))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(650)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(650)))
        .map_err(|err| err.to_string())?;

    // Flush anything the agent queued before we attached.
    let _ = stream.write_all(b"\xff{\"execute\":\"guest-sync\",\"arguments\":{\"id\":1}}\n");
    let mut discard = [0_u8; 4096];
    let _ = stream.read(&mut discard);

    let command = format!(r#"{{"execute":"{}"}}"#, execute);
    stream
        .write_all(command.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|err| format!("Commande QGA impossible: {}", err))?;

    let mut raw = Vec::with_capacity(16384);
    let mut buffer = [0_u8; 4096];
    for _ in 0..8 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                raw.extend_from_slice(&buffer[..size]);
                if raw.ends_with(b"\n") {
                    break;
                }
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(err) => return Err(format!("Lecture QGA impossible: {}", err)),
        }
    }
    let raw = String::from_utf8_lossy(&raw);
    let line = raw
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{') && line.contains("\"return\""))
        .unwrap_or(raw.trim());
    if line.is_empty() {
        return Err("Reponse QGA vide".to_string());
    }
    serde_json::from_str(line).map_err(|err| format!("Reponse QGA invalide: {}", err))
}

fn qga_guest_ip(port: u16) -> Option<String> {
    let response = qga_execute(port, "guest-network-get-interfaces").ok()?;
    let interfaces = response.get("return")?.as_array()?;
    for interface in interfaces {
        let name = interface
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if name == "lo" {
            continue;
        }
        let Some(addresses) = interface
            .get("ip-addresses")
            .and_then(|value| value.as_array())
        else {
            continue;
        };
        for address in addresses {
            let ip_type = address
                .get("ip-address-type")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let ip = address
                .get("ip-address")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if ip_type == "ipv4" && !ip.starts_with("127.") && !ip.is_empty() {
                return Some(ip.to_string());
            }
        }
    }
    None
}

fn qga_is_running(port: u16) -> bool {
    qga_execute(port, "guest-ping").is_ok()
}

fn clear_vm_guest_agent_state(vm: &mut LocalVm) {
    vm.qga_port = None;
    vm.guest_ip = None;
    vm.guest_agent_running = false;
    vm.qga_last_probe_at = None;
}

/// One writer at a time for the on-disk inventory. Every mutating command used
/// to read/modify/write `local-vms.json` concurrently with the 7 s UI refresh,
/// which is how a VM could vanish from the list or come back with stale ports.
static INVENTORY_LOCK: Mutex<()> = Mutex::new(());

fn inventory_guard() -> std::sync::MutexGuard<'static, ()> {
    INVENTORY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn connect_local_port_with_retry(port: u16) -> Result<tokio::net::TcpStream, String> {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(8);
    loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => return Ok(stream),
            Err(err) if tokio::time::Instant::now() < deadline => {
                let _ = err;
                tokio::time::sleep(tokio::time::Duration::from_millis(180)).await;
            }
            Err(err) => return Err(format!("Port local {} indisponible: {}", port, err)),
        }
    }
}

fn negotiate_binary_protocol(
    req: &Request,
    mut response: Response,
) -> Result<Response, ErrorResponse> {
    let wants_binary = req
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').any(|protocol| protocol.trim() == "binary"))
        .unwrap_or(false);

    if wants_binary {
        response
            .headers_mut()
            .insert("sec-websocket-protocol", HeaderValue::from_static("binary"));
    }

    Ok(response)
}

/// A PID alone is not proof a VM is alive: the OS recycles PIDs, and a
/// recycled one used to make Virtua believe a stopped VM was running (and then
/// try to talk QMP to an unrelated process). Match the QEMU `-name` too.
fn vm_process_alive(vm: &LocalVm) -> bool {
    let Some(pid) = vm.pid else {
        return false;
    };
    platform::named_qemu_alive(pid, &vm.id) || platform::named_qemu_alive(pid, &vm.name)
}

fn refresh_vm_states(mut vms: Vec<LocalVm>) -> Result<Vec<LocalVm>, String> {
    let mut changed = false;
    let live_pids: Vec<u32> = vms
        .iter()
        .filter(|vm| vm_process_alive(vm))
        .filter_map(|vm| vm.pid)
        .collect();
    let metrics = platform::process_metrics(&live_pids);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    for vm in &mut vms {
        if vm.pid.is_none() {
            vm.vnc_port = None;
            vm.spice_port = None;
            vm.qmp_port = None;
            vm.cpu_usage = None;
            vm.memory_usage = None;
            vm.uptime_seconds = None;
            continue;
        }
        if !vm_process_alive(vm) {
            vm.pid = None;
            vm.vnc_port = None;
            vm.spice_port = None;
            vm.spice_password = None;
            vm.qmp_port = None;
            clear_vm_guest_agent_state(vm);
            vm.cpu_usage = None;
            vm.memory_usage = None;
            vm.uptime_seconds = None;
            vm.state = "stopped".to_string();
            vm.updated_at = now_string();
            changed = true;
            continue;
        }

        if vm.state != "running" && vm.state != "stopping" {
            vm.state = "running".to_string();
            changed = true;
        }
        if let Some((cpu, memory_bytes, uptime)) = vm.pid.and_then(|pid| metrics.get(&pid).copied())
        {
            let budget = (vm.memory_mib as f32 * 1024.0 * 1024.0).max(1.0);
            vm.cpu_usage = Some(cpu);
            vm.memory_usage = Some(((memory_bytes as f32 / budget) * 100.0).clamp(0.0, 100.0));
            vm.uptime_seconds = Some(uptime);
        }
        match vm.qga_port {
            Some(port) => {
                let should_probe = vm
                    .qga_last_probe_at
                    .map(|last| now.saturating_sub(last) >= 10)
                    .unwrap_or(true);
                if should_probe {
                    vm.guest_agent_running = qga_is_running(port);
                    vm.guest_ip = if vm.guest_agent_running {
                        qga_guest_ip(port)
                    } else {
                        None
                    };
                    vm.qga_last_probe_at = Some(now);
                    changed = true;
                }
            }
            None => {
                vm.guest_agent_running = false;
                vm.guest_ip = None;
                vm.qga_last_probe_at = None;
            }
        }
    }
    if changed {
        write_local_vms(&vms)?;
    }
    Ok(vms)
}

fn find_qemu_firmware(architecture: &str) -> Option<String> {
    platform::firmware(architecture)
}

fn binary_status(binary: &str) -> LocalBinaryStatus {
    let path = find_binary(binary);
    LocalBinaryStatus {
        available: path.is_some(),
        path,
    }
}

fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = if program == "docker" {
        docker::command()?
    } else {
        platform::command(program)
    };
    let output = command
        .args(args)
        .output()
        .map_err(|err| format!("{} impossible a lancer: {}", program, err))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{} a echoue", program)
        } else {
            stderr
        })
    }
}

fn normalize_container_state(raw: &str) -> String {
    let value = raw.trim().to_lowercase();
    if value.contains("running") || value == "up" || value == "started" {
        "running".to_string()
    } else if value.contains("paused") {
        "paused".to_string()
    } else {
        "stopped".to_string()
    }
}

fn list_docker_resources() -> Vec<LocalContainerResource> {
    docker::list()
}

fn list_lxc_resources() -> Vec<LocalContainerResource> {
    containers::list().unwrap_or_default()
}

fn local_list_containers_blocking() -> Vec<LocalContainerResource> {
    let mut resources = list_lxc_resources();
    resources.extend(list_docker_resources());
    resources
}

fn safe_container_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || !trimmed.as_bytes()[0].is_ascii_alphanumeric() {
        return Err("Nom invalide".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(
            "Nom invalide: utilise lettres, chiffres, tirets, points ou underscores".to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn read_storage_config() -> Result<LocalStorageConfig, String> {
    let path = storage_config_path()?;
    if !path.exists() {
        return default_storage_config();
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&raw).map_err(|err| err.to_string())
}

fn ensure_storage_dirs(config: &LocalStorageConfig) -> Result<(), String> {
    for path in [
        &config.vm_config_dir,
        &config.disk_dir,
        &config.iso_dir,
        &config.snapshot_dir,
        &config.export_dir,
    ] {
        fs::create_dir_all(path)
            .map_err(|err| format!("Creation dossier impossible {}: {}", path, err))?;
    }
    Ok(())
}

fn read_local_vms() -> Result<Vec<LocalVm>, String> {
    let path = inventory_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let vms: Vec<LocalVm> = match serde_json::from_str(&raw) {
        Ok(vms) => vms,
        Err(err) => {
            // Keep the damaged file for support, but let the app start.
            let _ = fs::rename(&path, path.with_extension("json.corrupt"));
            return Err(format!(
                "Inventaire local illisible ({}). Il a ete mis de cote; les disques sont conserves.",
                err
            ));
        }
    };
    refresh_vm_states(vms)
}

/// Write through a temporary file: a crash (or a Windows "not responding" kill)
/// in the middle of a plain `fs::write` truncated the inventory and lost every
/// registered VM.
fn write_json_atomic(path: &Path, raw: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, raw).map_err(|err| err.to_string())?;
    // Windows refuses to rename onto an existing file.
    if cfg!(windows) && path.exists() {
        fs::copy(&temp, path).map_err(|err| err.to_string())?;
        let _ = fs::remove_file(&temp);
        return Ok(());
    }
    fs::rename(&temp, path).map_err(|err| err.to_string())
}

fn write_local_vms(vms: &[LocalVm]) -> Result<(), String> {
    let path = inventory_path()?;
    let raw = serde_json::to_string_pretty(vms).map_err(|err| err.to_string())?;
    write_json_atomic(&path, &raw)
}

fn read_local_snapshots() -> Result<Vec<LocalSnapshot>, String> {
    let path = snapshots_index_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let snapshots: Vec<LocalSnapshot> =
        serde_json::from_str(&raw).map_err(|err| err.to_string())?;
    Ok(snapshots
        .into_iter()
        .filter(|snapshot| PathBuf::from(&snapshot.path).exists())
        .collect())
}

fn write_local_snapshots(snapshots: &[LocalSnapshot]) -> Result<(), String> {
    let path = snapshots_index_path()?;
    let raw = serde_json::to_string_pretty(snapshots).map_err(|err| err.to_string())?;
    write_json_atomic(&path, &raw)
}

fn safe_file_name(name: &str) -> Result<String, String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '-'
            }
        })
        .collect();
    let clean = clean.trim_matches('-').to_string();
    if clean.is_empty() {
        Err("Nom de VM invalide".to_string())
    } else {
        Ok(clean)
    }
}

/// Jeton aleatoire (128 bits, hex) pour authentifier le proxy console local.
fn random_token() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        return format!("{:032x}", nanos);
    }
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

/// Reduit un nom de fichier distant a son seul composant final et rejette toute
/// tentative de traversee de chemin (../, chemin absolu, separateurs).
fn safe_download_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let candidate = Path::new(trimmed)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| "Nom de fichier invalide".to_string())?;
    if candidate.is_empty()
        || candidate == "."
        || candidate == ".."
        || candidate.contains('/')
        || candidate.contains('\\')
    {
        return Err("Nom de fichier invalide".to_string());
    }
    Ok(candidate)
}

fn file_modified_string(metadata: &fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
}

fn scan_files(dir: &str, extensions: &[&str]) -> Vec<LocalStorageFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };

    let mut files: Vec<LocalStorageFile> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !extensions.is_empty() && !extensions.iter().any(|ext| lower.ends_with(ext)) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some(LocalStorageFile {
                name,
                path: path.to_string_lossy().to_string(),
                size: metadata.len(),
                modified_at: file_modified_string(&metadata),
            })
        })
        .collect();
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files
}

fn docker_images() -> Vec<LocalDockerImage> {
    let Ok(raw) = docker::probe(&[
        "images",
        "--format",
        "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}",
    ]) else {
        return vec![];
    };

    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            Some(LocalDockerImage {
                repository: parts.next()?.to_string(),
                tag: parts.next()?.to_string(),
                image_id: parts.next()?.to_string(),
                size: parts.next()?.to_string(),
            })
        })
        .collect()
}

fn repository_arch(arch: &str) -> Result<&'static str, String> {
    match normalize_arch(arch).as_str() {
        "arm64" => Ok("ARM"),
        "amd64" => Ok("AMD64"),
        _ => Err("Architecture depot inconnue".to_string()),
    }
}

fn repository_category(category: &str) -> Result<&'static str, String> {
    match category.to_uppercase().as_str() {
        "ISO" => Ok("ISO"),
        "VM" => Ok("VM"),
        _ => Err("Categorie depot inconnue".to_string()),
    }
}

fn repository_url(category: &str, arch: &str) -> Result<String, String> {
    Ok(format!(
        "https://dep.auxinux.ca/TEMPLATES/{}/{}/",
        repository_category(category)?,
        repository_arch(arch)?,
    ))
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn parse_nginx_listing(
    html: &str,
    base_url: &str,
    category: &str,
    arch: &str,
) -> Vec<RemoteTemplateItem> {
    let mut entries: Vec<(String, Option<String>, Option<String>)> = vec![];
    for line in html.lines() {
        let Some(href_start) = line.find("href=\"") else {
            continue;
        };
        let href_rest = &line[href_start + 6..];
        let Some(href_end) = href_rest.find('"') else {
            continue;
        };
        let href = html_unescape(&href_rest[..href_end]);
        if href == "../" || href.ends_with('/') {
            continue;
        }
        let name = html_unescape(href.trim_end_matches('/'));
        let tail = href_rest[href_end + 1..].trim();
        let text_tail = tail
            .split('<')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>();
        let modified_at = if text_tail.len() >= 2 {
            Some(format!("{} {}", text_tail[0], text_tail[1]))
        } else {
            None
        };
        let size = text_tail.last().map(|value| (*value).to_string());
        entries.push((name, modified_at, size));
    }

    let metadata_by_stem: std::collections::HashMap<String, (String, TemplateMetadata)> = entries
        .iter()
        .filter_map(|(name, _, _)| {
            if !category.eq_ignore_ascii_case("VM") || !name.to_lowercase().ends_with(".json") {
                return None;
            }
            let url = format!("{}{}", base_url, name);
            let metadata = fetch_template_metadata(&url).ok()?;
            Some((template_stem(name), (url, metadata)))
        })
        .collect();

    let mut items = vec![];
    for (name, modified_at, size) in entries {
        let lower = name.to_lowercase();
        if category.eq_ignore_ascii_case("ISO") && !lower.ends_with(".iso") {
            continue;
        }
        if category.eq_ignore_ascii_case("VM")
            && !(lower.ends_with(".tar.gz") || lower.ends_with(".tgz"))
        {
            continue;
        }
        let (metadata_url, metadata) = metadata_by_stem
            .get(&template_stem(&name))
            .cloned()
            .unwrap_or_default();
        items.push(RemoteTemplateItem {
            category: category.to_uppercase(),
            architecture: metadata
                .arch
                .as_deref()
                .map(normalize_arch)
                .unwrap_or_else(|| normalize_arch(arch)),
            name: name.clone(),
            url: format!("{}{}", base_url, name),
            size,
            modified_at,
            display_name: metadata.name,
            description: metadata.desc,
            cpu: metadata.cpu,
            ram: metadata.ram,
            disk: metadata.disk,
            metadata_url: if metadata_url.is_empty() {
                None
            } else {
                Some(metadata_url)
            },
        });
    }
    items
}

fn template_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".tar.gz") {
        name[..name.len().saturating_sub(7)].to_string()
    } else if lower.ends_with(".tgz") {
        name[..name.len().saturating_sub(4)].to_string()
    } else if lower.ends_with(".json") {
        name[..name.len().saturating_sub(5)].to_string()
    } else {
        name.to_string()
    }
}

/// Every repository call goes through a client with real timeouts: a hung
/// mirror used to block the calling thread — and, for the synchronous
/// commands, the whole UI — until the OS gave up.
fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent("AuxiNux-Virtua-Desktop/0.2.1")
        .build()
        .map_err(|err| format!("Client HTTP impossible: {}", err))
}

fn fetch_template_metadata(url: &str) -> Result<TemplateMetadata, String> {
    let response = http_client(Duration::from_secs(15))?
        .get(url)
        .send()
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let raw = response.text().map_err(|err| err.to_string())?;
    serde_json::from_str::<TemplateMetadata>(&raw).map_err(|err| err.to_string())
}

fn download_small_file(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut response = http_client(Duration::from_secs(60))?
        .get(url)
        .send()
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Telechargement metadata impossible: HTTP {}",
            response.status()
        ));
    }
    let mut file = fs::File::create(destination).map_err(|err| err.to_string())?;
    std::io::copy(&mut response, &mut file).map_err(|err| err.to_string())?;
    Ok(())
}

fn emit_download_progress(app: &tauri::AppHandle, event: DownloadProgressEvent) {
    let _ = app.emit("local-download-progress", event);
}

fn download_file_with_progress(
    app: &tauri::AppHandle,
    id: &str,
    name: &str,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    emit_download_progress(
        app,
        DownloadProgressEvent {
            id: id.to_string(),
            name: name.to_string(),
            received: 0,
            total: None,
            progress: Some(0.0),
            status: "downloading".to_string(),
        },
    );

    let temp_destination = destination.with_extension(format!(
        "{}download",
        destination
            .extension()
            .map(|value| format!("{}.", value.to_string_lossy()))
            .unwrap_or_default()
    ));

    let mut response = http_client(Duration::from_secs(7200))?
        .get(url)
        .send()
        .map_err(|err| format!("Telechargement impossible: {}", err))?;

    if !response.status().is_success() {
        return Err(format!(
            "Telechargement impossible: HTTP {}",
            response.status()
        ));
    }

    let total = response.content_length();
    let mut file = fs::File::create(&temp_destination).map_err(|err| err.to_string())?;
    let mut received = 0_u64;
    let mut last_emit = 0_u64;
    let mut buffer = [0_u8; 1024 * 128];

    loop {
        let size = response
            .read(&mut buffer)
            .map_err(|err| format!("Lecture telechargement impossible: {}", err))?;
        if size == 0 {
            break;
        }
        file.write_all(&buffer[..size])
            .map_err(|err| err.to_string())?;
        received += size as u64;
        if received.saturating_sub(last_emit) >= 1024 * 512
            || total.map(|value| received >= value).unwrap_or(false)
        {
            last_emit = received;
            emit_download_progress(
                app,
                DownloadProgressEvent {
                    id: id.to_string(),
                    name: name.to_string(),
                    received,
                    total,
                    progress: total
                        .map(|value| ((received as f32 / value as f32) * 100.0).clamp(0.0, 100.0)),
                    status: "downloading".to_string(),
                },
            );
        }
    }

    file.flush().map_err(|err| err.to_string())?;
    fs::rename(&temp_destination, destination)
        .or_else(|_| {
            fs::copy(&temp_destination, destination)
                .and_then(|_| fs::remove_file(&temp_destination))
                .map(|_| ())
        })
        .map_err(|err| err.to_string())?;

    let metadata = fs::metadata(destination).map_err(|err| err.to_string())?;
    emit_download_progress(
        app,
        DownloadProgressEvent {
            id: id.to_string(),
            name: name.to_string(),
            received: metadata.len(),
            total: total.or(Some(metadata.len())),
            progress: Some(100.0),
            status: "completed".to_string(),
        },
    );
    Ok(())
}

/// Templates are packed/unpacked in-process. Windows only ships bsdtar (with a
/// different option set) and macOS/Linux `tar` behaviour varies, so shelling
/// out was the least portable step of the whole import path.
/// Refuse absolute paths, `..` and Windows drive prefixes: an untrusted
/// archive must not be able to write outside the extraction directory.
fn tar_entry_is_safe(path: &Path) -> bool {
    !path.is_absolute()
        && path.components().all(|part| {
            matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> Result<(), String> {
    let file =
        fs::File::open(archive).map_err(|err| format!("Ouverture template impossible: {}", err))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    archive.set_overwrite(true);
    archive.set_preserve_permissions(false);
    archive.set_preserve_mtime(false);
    for entry in archive
        .entries()
        .map_err(|err| format!("Template illisible: {}", err))?
    {
        let mut entry = entry.map_err(|err| format!("Template illisible: {}", err))?;
        let path = entry
            .path()
            .map_err(|err| format!("Chemin invalide dans le template: {}", err))?
            .into_owned();
        if !tar_entry_is_safe(&path) {
            return Err(format!("Entree de template refusee: {}", path.display()));
        }
        if !matches!(
            entry.header().entry_type(),
            tar::EntryType::Regular | tar::EntryType::Directory
        ) {
            continue;
        }
        entry
            .unpack_in(destination)
            .map_err(|err| format!("Extraction template impossible: {}", err))?;
    }
    Ok(())
}

fn create_tar_gz(archive: &Path, root: &Path, files: &[&str]) -> Result<(), String> {
    let file =
        fs::File::create(archive).map_err(|err| format!("Creation archive impossible: {}", err))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder.follow_symlinks(false);
    for name in files {
        builder
            .append_path_with_name(root.join(name), name)
            .map_err(|err| format!("Compression template impossible: {}", err))?;
    }
    builder
        .into_inner()
        .and_then(|encoder| encoder.finish())
        .map_err(|err| format!("Compression template impossible: {}", err))?;
    Ok(())
}

fn read_template_config(path: &Path) -> Result<std::collections::HashMap<String, String>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Lecture config.virtua impossible: {}", err))?;
    let mut config = std::collections::HashMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('[') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        config.insert(key.trim().to_uppercase(), value.trim().to_string());
    }
    Ok(config)
}

fn template_bool(
    config: &std::collections::HashMap<String, String>,
    key: &str,
    default_value: bool,
) -> bool {
    config
        .get(key)
        .map(|value| {
            matches!(
                value.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "oui" | "on" | "enabled" | "actif"
            )
        })
        .unwrap_or(default_value)
}

fn is_path_inside(child: &Path, parent: &Path) -> bool {
    match (child.canonicalize(), parent.canonicalize()) {
        (Ok(child), Ok(parent)) => child.starts_with(parent),
        _ => false,
    }
}

#[tauri::command(async)]
fn save_refresh_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_ACCOUNT)
        .map_err(|err| err.to_string())?;
    entry.set_password(&token).map_err(|err| err.to_string())
}

#[tauri::command(async)]
fn load_refresh_token() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_ACCOUNT)
        .map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn clear_refresh_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_ACCOUNT)
        .map_err(|err| err.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn save_desktop_setting(key: String, value: String) -> Result<(), String> {
    let account = account_for_key(&key)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
    entry.set_password(&value).map_err(|err| err.to_string())
}

#[tauri::command(async)]
fn load_desktop_setting(key: String) -> Result<Option<String>, String> {
    let account = account_for_key(&key)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command(async)]
fn clear_desktop_setting(key: String) -> Result<(), String> {
    let account = account_for_key(&key)?;
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn runtime_platform() -> RuntimePlatform {
    RuntimePlatform {
        os: env::consts::OS.to_string(),
        arch: normalize_arch(env::consts::ARCH).to_string(),
        mobile: cfg!(any(target_os = "ios", target_os = "android")),
    }
}

#[tauri::command]
async fn local_host_metrics() -> Result<LocalHostMetrics, String> {
    tauri::async_runtime::spawn_blocking(local_host_metrics_blocking)
        .await
        .map_err(|err| err.to_string())?
}

fn local_host_metrics_blocking() -> Result<LocalHostMetrics, String> {
    platform::metrics()
}

#[tauri::command]
async fn local_qemu_diagnostics() -> Result<LocalQemuDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(qemu_diagnostics_blocking)
        .await
        .map_err(|e| e.to_string())?
}

static DIAGNOSTICS_CACHE: Mutex<Option<(u64, LocalQemuDiagnostics)>> = Mutex::new(None);
const DIAGNOSTICS_TTL_SECONDS: u64 = 5;

/// Drop the cached QEMU probe: an engine installation changes the answer.
fn forget_diagnostics() {
    if let Ok(mut cache) = DIAGNOSTICS_CACHE.lock() {
        *cache = None;
    }
    platform::forget_caches();
}

fn qemu_diagnostics_blocking() -> Result<LocalQemuDiagnostics, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(cache) = DIAGNOSTICS_CACHE.lock() {
        if let Some((stamp, diagnostics)) = cache.as_ref() {
            if now.saturating_sub(*stamp) < DIAGNOSTICS_TTL_SECONDS {
                return Ok(diagnostics.clone());
            }
        }
    }
    let diagnostics = probe_qemu_diagnostics()?;
    if let Ok(mut cache) = DIAGNOSTICS_CACHE.lock() {
        *cache = Some((now, diagnostics.clone()));
    }
    Ok(diagnostics)
}

fn probe_qemu_diagnostics() -> Result<LocalQemuDiagnostics, String> {
    let host_arch = normalize_arch(env::consts::ARCH);
    let qemu_img = binary_status("qemu-img");
    let qemu_system_arm64 = binary_status("qemu-system-aarch64");
    let qemu_system_amd64 = binary_status("qemu-system-x86_64");
    let homebrew = binary_status("brew");
    let native = if host_arch == "arm64" {
        "qemu-system-aarch64"
    } else {
        "qemu-system-x86_64"
    };
    let ready = qemu_img.available
        && platform::probe("qemu-img", &["--version"]).is_ok()
        && platform::probe(native, &["--version"]).is_ok();
    let accelerator = Some(platform::accelerator(&host_arch));

    Ok(LocalQemuDiagnostics {
        os: env::consts::OS.to_string(),
        host_arch,
        accelerator,
        qemu_img,
        qemu_system_arm64,
        qemu_system_amd64,
        homebrew,
        ready,
    })
}

#[tauri::command(async)]
fn local_load_storage_config() -> Result<LocalStorageConfig, String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    Ok(config)
}

#[tauri::command(async)]
fn local_save_storage_config(config: LocalStorageConfig) -> Result<LocalStorageConfig, String> {
    ensure_storage_dirs(&config)?;
    let path = storage_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(path, raw).map_err(|err| err.to_string())?;
    Ok(config)
}

#[tauri::command]
async fn local_storage_inventory() -> Result<LocalStorageInventory, String> {
    tauri::async_runtime::spawn_blocking(local_storage_inventory_blocking)
        .await
        .map_err(|err| err.to_string())?
}

fn local_storage_inventory_blocking() -> Result<LocalStorageInventory, String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let template_dir = template_cache_dir()?;
    fs::create_dir_all(&template_dir).map_err(|err| err.to_string())?;
    Ok(LocalStorageInventory {
        iso: scan_files(&config.iso_dir, &[".iso", ".img"]),
        templates: scan_files(&template_dir.to_string_lossy(), &[".tar.gz", ".tgz"]),
        disks: scan_files(&config.disk_dir, &[".qcow2", ".img", ".raw"]),
        snapshots: scan_files(
            &config.snapshot_dir,
            &[".qcow2", ".img", ".raw", ".tar.gz", ".tgz"],
        ),
        exports: scan_files(&config.export_dir, &[".tar.gz", ".tgz", ".iso", ".qcow2"]),
        docker_images: docker_images(),
    })
}

#[tauri::command]
async fn local_list_remote_templates(
    request: RemoteTemplateRequest,
) -> Result<Vec<RemoteTemplateItem>, String> {
    tauri::async_runtime::spawn_blocking(move || local_list_remote_templates_blocking(request))
        .await
        .map_err(|err| err.to_string())?
}

fn local_list_remote_templates_blocking(
    request: RemoteTemplateRequest,
) -> Result<Vec<RemoteTemplateItem>, String> {
    let base_url = repository_url(&request.category, &request.architecture)?;
    let response = http_client(Duration::from_secs(20))?
        .get(&base_url)
        .send()
        .map_err(|err| format!("Depot inaccessible: {}", err))?;
    if !response.status().is_success() {
        return Err(format!("Depot inaccessible: HTTP {}", response.status()));
    }
    let html = response
        .text()
        .map_err(|err| format!("Depot illisible: {}", err))?;
    Ok(parse_nginx_listing(
        &html,
        &base_url,
        &request.category,
        &request.architecture,
    ))
}

#[tauri::command]
async fn local_download_template(
    app: tauri::AppHandle,
    payload: DownloadTemplatePayload,
) -> Result<Option<LocalVm>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_download_template_blocking(app, payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_download_template_blocking(
    app: tauri::AppHandle,
    payload: DownloadTemplatePayload,
) -> Result<Option<LocalVm>, String> {
    let category = repository_category(&payload.category)?;
    let architecture = normalize_arch(&payload.architecture);
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;

    let safe_name = safe_download_name(&payload.name)?;

    if category == "ISO" {
        let destination = PathBuf::from(&config.iso_dir).join(&safe_name);
        download_file_with_progress(&app, &payload.url, &safe_name, &payload.url, &destination)?;
        return Ok(None);
    }

    let template_dir = template_cache_dir()?;
    fs::create_dir_all(&template_dir).map_err(|err| err.to_string())?;
    let archive_path = template_dir.join(&safe_name);
    download_file_with_progress(&app, &payload.url, &safe_name, &payload.url, &archive_path)?;
    if let Some(metadata_url) = payload.metadata_url.as_deref() {
        let json_name = format!("{}.json", template_stem(&safe_name));
        let _ = download_small_file(metadata_url, &template_dir.join(json_name));
    }
    emit_download_progress(
        &app,
        DownloadProgressEvent {
            id: payload.url.clone(),
            name: payload.name.clone(),
            received: fs::metadata(&archive_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            total: fs::metadata(&archive_path)
                .map(|metadata| Some(metadata.len()))
                .unwrap_or(None),
            progress: Some(100.0),
            status: "extracting".to_string(),
        },
    );
    let vm = import_template_archive(&archive_path, architecture)?;
    emit_download_progress(
        &app,
        DownloadProgressEvent {
            id: payload.url.clone(),
            name: payload.name.clone(),
            received: fs::metadata(&archive_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            total: fs::metadata(&archive_path)
                .map(|metadata| Some(metadata.len()))
                .unwrap_or(None),
            progress: Some(100.0),
            status: "completed".to_string(),
        },
    );
    Ok(Some(vm))
}

/// Deletes the extraction directory on the way out, whatever happened. A
/// template holds a full disk image: leaving one behind on an error silently
/// doubled the space the import cost.
struct ScratchDir(PathBuf);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn import_template_archive(
    archive_path: &Path,
    mut architecture: String,
) -> Result<LocalVm, String> {
    if !archive_path.exists() {
        return Err("Template introuvable".to_string());
    }
    let archive_name = archive_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "template".to_string());
    let safe_name = safe_file_name(&archive_name)?;
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let template_dir = template_cache_dir()?;
    fs::create_dir_all(&template_dir).map_err(|err| err.to_string())?;
    let extract_root = template_dir.join(format!("{}-{}", safe_name, now_string()));
    fs::create_dir_all(&extract_root).map_err(|err| err.to_string())?;
    let _scratch = ScratchDir(extract_root.clone());
    extract_tar_gz(archive_path, &extract_root)?;

    let config_path = extract_root.join("config.virtua");
    if !config_path.exists() {
        return Err("config.virtua introuvable dans le template".to_string());
    }
    let template_config = read_template_config(&config_path)?;
    if let Some(template_architecture) = template_config.get("ARCH") {
        architecture = normalize_arch(template_architecture);
    }
    let name = template_config
        .get("NAME")
        .cloned()
        .unwrap_or_else(|| safe_name.clone());
    let cpu = template_config
        .get("CPU")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(2);
    let memory_mib = template_config
        .get("RAM")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(2048);
    let tpm2 = template_bool(&template_config, "TPM2", false);
    let secure_boot = template_bool(&template_config, "SECUREBOOT", false);
    let disk_name = template_config
        .get("DISK")
        .ok_or_else(|| "DISK absent dans config.virtua".to_string())?;
    let extracted_disk = extract_root.join(disk_name);
    if !extracted_disk.exists() {
        return Err(format!("Disque template introuvable: {}", disk_name));
    }

    let mut vms = read_local_vms()?;
    let unique_name = if vms.iter().any(|vm| vm.name.eq_ignore_ascii_case(&name)) {
        format!("{}-{}", name, now_string())
    } else {
        name
    };
    let id = now_id();
    let destination_disk_name = format!("{}-{}.qcow2", safe_file_name(&unique_name)?, id);
    let destination_disk = PathBuf::from(&config.disk_dir).join(destination_disk_name);
    fs::copy(&extracted_disk, &destination_disk)
        .map_err(|err| format!("Copie disque impossible: {}", err))?;
    let disk_gib = fs::metadata(&destination_disk)
        .map(|metadata| ((metadata.len() as f64 / 1024.0 / 1024.0 / 1024.0).ceil() as u32).max(1))
        .unwrap_or(1);
    let timestamp = now_string();
    let vm = LocalVm {
        id,
        name: unique_name,
        architecture,
        cpu,
        memory_mib,
        disk_gib,
        disk_path: destination_disk.to_string_lossy().to_string(),
        iso_path: None,
        network: "user".to_string(),
        network_model: default_network_model(),
        gpu_model: default_gpu_model(),
        disk_bus: default_disk_bus(),
        tpm2,
        secure_boot,
        state: "stopped".to_string(),
        pid: None,
        vnc_port: None,
        spice_port: None,
        spice_password: None,
        qmp_port: None,
        qga_port: None,
        guest_ip: None,
        guest_agent_running: false,
        qga_last_probe_at: None,
        cpu_usage: None,
        memory_usage: None,
        uptime_seconds: None,
        startup_notes: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    vms.push(vm.clone());
    write_local_vms(&vms)?;
    Ok(vm)
}

#[tauri::command]
async fn local_import_vm_template(payload: ImportTemplatePayload) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        import_template_archive(
            &PathBuf::from(payload.template_path),
            normalize_arch(&payload.architecture),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn local_export_vm_template(
    payload: ExportTemplatePayload,
) -> Result<LocalStorageFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_export_vm_template_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_export_vm_template_blocking(
    payload: ExportTemplatePayload,
) -> Result<LocalStorageFile, String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let template_dir = template_cache_dir()?;
    fs::create_dir_all(&template_dir).map_err(|err| err.to_string())?;
    let vms = read_local_vms()?;
    let vm = vms
        .iter()
        .find(|vm| vm.id == payload.vm_id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    if vm.pid.is_some() || vm.state == "running" {
        return Err("Arrete la VM avant de creer un template".to_string());
    }

    let template_name = safe_file_name(&payload.template_name)?;
    let work_dir = template_dir.join(format!("{}-work-{}", template_name, now_string()));
    fs::create_dir_all(&work_dir).map_err(|err| err.to_string())?;
    let _scratch = ScratchDir(work_dir.clone());
    let source_disk = PathBuf::from(&vm.disk_path);
    let disk_name = source_disk
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("{}.qcow2", template_name));
    let disk_copy = work_dir.join(&disk_name);
    fs::copy(&source_disk, &disk_copy)
        .map_err(|err| format!("Copie disque impossible: {}", err))?;
    let description = payload.description.unwrap_or_default();
    let config_description = description.replace(['\r', '\n'], " ");

    let config_text = format!(
        "[CONFIG VM TEMPLATE]\nName={}\nDesc={}\nCPU={}\nRAM={}\nDISK={}\nARCH={}\nTPM2={}\nSECUREBOOT={}\n",
        vm.name, config_description, vm.cpu, vm.memory_mib, disk_name, vm.architecture, vm.tpm2, vm.secure_boot
    );
    fs::write(work_dir.join("config.virtua"), config_text).map_err(|err| err.to_string())?;

    let archive_path = template_dir.join(format!("{}.tar.gz", template_name));
    let metadata_path = template_dir.join(format!("{}.json", template_name));
    let metadata = TemplateMetadata {
        name: Some(vm.name.clone()),
        desc: if description.trim().is_empty() {
            None
        } else {
            Some(description)
        },
        cpu: Some(vm.cpu),
        ram: Some(vm.memory_mib),
        disk: Some(disk_name.clone()),
        arch: Some(vm.architecture.clone()),
        tpm2: Some(vm.tpm2),
        secure_boot: Some(vm.secure_boot),
    };
    let metadata_raw = serde_json::to_string_pretty(&metadata).map_err(|err| err.to_string())?;
    fs::write(&metadata_path, metadata_raw).map_err(|err| err.to_string())?;

    create_tar_gz(&archive_path, &work_dir, &["config.virtua", &disk_name])?;
    let metadata = fs::metadata(&archive_path).map_err(|err| err.to_string())?;
    Ok(LocalStorageFile {
        name: archive_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}.tar.gz", template_name)),
        path: archive_path.to_string_lossy().to_string(),
        size: metadata.len(),
        modified_at: file_modified_string(&metadata),
    })
}

#[tauri::command]
async fn local_delete_storage_file(payload: DeleteStorageFilePayload) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_delete_storage_file_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_delete_storage_file_blocking(payload: DeleteStorageFilePayload) -> Result<(), String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let kind = payload.kind.to_lowercase();
    let path = PathBuf::from(&payload.path);
    if !path.is_file() {
        return Err("Fichier introuvable".to_string());
    }

    let root = match kind.as_str() {
        "iso" => PathBuf::from(&config.iso_dir),
        "template" | "templates" => template_cache_dir()?,
        "disk" | "disks" => PathBuf::from(&config.disk_dir),
        "snapshot" | "snapshots" => PathBuf::from(&config.snapshot_dir),
        _ => return Err("Type de stockage inconnu".to_string()),
    };
    if !is_path_inside(&path, &root) {
        return Err("Suppression refusee hors du stockage Virtua".to_string());
    }

    if kind == "disk" || kind == "disks" {
        let canonical = path.canonicalize().map_err(|err| err.to_string())?;
        let vms = read_local_vms()?;
        let used = vms.iter().any(|vm| {
            PathBuf::from(&vm.disk_path)
                .canonicalize()
                .map(|disk| disk == canonical)
                .unwrap_or(false)
        });
        if used {
            return Err("Ce disque est encore utilise par une VM".to_string());
        }
    }

    fs::remove_file(&path).map_err(|err| err.to_string())?;
    if kind == "template" || kind == "templates" {
        let template_file_name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| payload.path.clone());
        let json_path = root.join(format!("{}.json", template_stem(&template_file_name)));
        if json_path.exists() && is_path_inside(&json_path, &root) {
            let _ = fs::remove_file(json_path);
        }
    }
    if kind == "snapshot" || kind == "snapshots" {
        let path_string = path.to_string_lossy().to_string();
        let snapshots: Vec<LocalSnapshot> = read_local_snapshots()?
            .into_iter()
            .filter(|snapshot| snapshot.path != path_string)
            .collect();
        write_local_snapshots(&snapshots)?;
    }
    Ok(())
}

#[tauri::command(async)]
fn local_list_snapshots(vm_id: String) -> Result<Vec<LocalSnapshot>, String> {
    let mut snapshots: Vec<LocalSnapshot> = read_local_snapshots()?
        .into_iter()
        .filter(|snapshot| snapshot.vm_id == vm_id)
        .collect();
    snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(snapshots)
}

#[tauri::command]
async fn local_create_snapshot(payload: CreateSnapshotPayload) -> Result<LocalSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_create_snapshot_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_create_snapshot_blocking(payload: CreateSnapshotPayload) -> Result<LocalSnapshot, String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let vms = read_local_vms()?;
    let vm = vms
        .iter()
        .find(|vm| vm.id == payload.vm_id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    if vm.pid.is_some() || vm.state == "running" || vm.state == "stopping" {
        return Err("Arrete la VM avant de creer un snapshot local".to_string());
    }
    let snapshot_name = safe_file_name(&payload.name)?;
    let source_disk = PathBuf::from(&vm.disk_path);
    if !source_disk.exists() {
        return Err("Disque VM introuvable".to_string());
    }
    let id = format!("local-snapshot-{}", now_string());
    let file_name = format!(
        "{}-{}-{}.qcow2",
        safe_file_name(&vm.name)?,
        snapshot_name,
        now_string()
    );
    let destination = PathBuf::from(&config.snapshot_dir).join(file_name);
    fs::copy(&source_disk, &destination)
        .map_err(|err| format!("Creation snapshot impossible: {}", err))?;
    let metadata = fs::metadata(&destination).map_err(|err| err.to_string())?;
    let snapshot = LocalSnapshot {
        id,
        vm_id: vm.id.clone(),
        name: payload.name.trim().to_string(),
        path: destination.to_string_lossy().to_string(),
        size: metadata.len(),
        created_at: now_string(),
    };
    let mut snapshots = read_local_snapshots()?;
    snapshots.push(snapshot.clone());
    write_local_snapshots(&snapshots)?;
    Ok(snapshot)
}

#[tauri::command]
async fn local_delete_snapshot(payload: SnapshotActionPayload) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_delete_snapshot_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_delete_snapshot_blocking(payload: SnapshotActionPayload) -> Result<(), String> {
    let mut snapshots = read_local_snapshots()?;
    let index = snapshots
        .iter()
        .position(|snapshot| snapshot.vm_id == payload.vm_id && snapshot.id == payload.snapshot_id)
        .ok_or_else(|| "Snapshot introuvable".to_string())?;
    let snapshot = snapshots.remove(index);
    let config = read_storage_config()?;
    let path = PathBuf::from(&snapshot.path);
    if path.exists() && is_path_inside(&path, &PathBuf::from(&config.snapshot_dir)) {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    write_local_snapshots(&snapshots)
}

#[tauri::command]
async fn local_rollback_snapshot(payload: SnapshotActionPayload) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_rollback_snapshot_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_rollback_snapshot_blocking(payload: SnapshotActionPayload) -> Result<(), String> {
    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let mut vms = read_local_vms()?;
    let vm = vms
        .iter_mut()
        .find(|vm| vm.id == payload.vm_id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    if vm.pid.is_some() || vm.state == "running" || vm.state == "stopping" {
        return Err("Arrete la VM avant de restaurer un snapshot local".to_string());
    }
    let snapshot = read_local_snapshots()?
        .into_iter()
        .find(|snapshot| snapshot.vm_id == payload.vm_id && snapshot.id == payload.snapshot_id)
        .ok_or_else(|| "Snapshot introuvable".to_string())?;
    let snapshot_path = PathBuf::from(&snapshot.path);
    if !snapshot_path.exists()
        || !is_path_inside(&snapshot_path, &PathBuf::from(&config.snapshot_dir))
    {
        return Err("Fichier snapshot introuvable".to_string());
    }
    fs::copy(&snapshot_path, &vm.disk_path)
        .map_err(|err| format!("Rollback snapshot impossible: {}", err))?;
    vm.updated_at = now_string();
    write_local_vms(&vms)
}

#[tauri::command]
async fn local_list_vms() -> Result<Vec<LocalVm>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = inventory_guard();
        read_local_vms()
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn local_list_containers() -> Result<Vec<LocalContainerResource>, String> {
    tauri::async_runtime::spawn_blocking(local_list_containers_blocking)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn local_create_container(
    payload: LocalCreateContainerPayload,
) -> Result<LocalContainerResource, String> {
    tauri::async_runtime::spawn_blocking(move || local_create_container_blocking(payload))
        .await
        .map_err(|err| err.to_string())?
}

fn local_create_container_blocking(
    payload: LocalCreateContainerPayload,
) -> Result<LocalContainerResource, String> {
    let kind = payload.kind.trim().to_lowercase();
    let name = safe_container_name(&payload.name)?;
    match kind.as_str() {
        "lxc" => containers::create(payload),
        "docker" => {
            if find_binary("docker").is_none() {
                return Err(
                    "Docker CLI introuvable. Installe Docker Desktop ou Docker Engine.".to_string(),
                );
            }
            let image = payload.image.unwrap_or_else(|| "nginx:latest".to_string());
            let restart = payload.restart_policy.unwrap_or_else(|| {
                if payload.autostart.unwrap_or(false) {
                    "unless-stopped".to_string()
                } else {
                    "no".to_string()
                }
            });
            let mut args: Vec<String> = vec![
                "run".to_string(),
                "-d".to_string(),
                "--name".to_string(),
                name.clone(),
                "--restart".to_string(),
                restart,
            ];
            if let Some(cpu) = payload.cpu.filter(|value| *value > 0) {
                args.push("--cpus".to_string());
                args.push(cpu.to_string());
            }
            if let Some(memory) = payload.memory_mib.filter(|value| *value > 0) {
                args.push("--memory".to_string());
                args.push(format!("{}m", memory));
            }
            if let Some(network) = payload
                .network
                .as_deref()
                .filter(|value| !value.trim().is_empty() && *value != "bridge")
            {
                args.push("--network".to_string());
                args.push(network.to_string());
            }
            if let Some(ports) = payload.ports.as_deref() {
                for port in ports
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    args.push("-p".to_string());
                    args.push(port.to_string());
                }
            }
            if image.starts_with('-') || image.trim().is_empty() {
                return Err("Image Docker invalide".into());
            }
            args.push(image);
            let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
            command_output("docker", &arg_refs)?;
            list_docker_resources()
                .into_iter()
                .find(|resource| resource.name == name)
                .ok_or_else(|| {
                    "Conteneur Docker cree, mais introuvable dans l'inventaire".to_string()
                })
        }
        _ => Err("Type local non supporte".to_string()),
    }
}

#[tauri::command]
async fn local_create_vm(payload: LocalCreateVmPayload) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_create_vm_blocking(payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_create_vm_blocking(payload: LocalCreateVmPayload) -> Result<LocalVm, String> {
    let diagnostics = qemu_diagnostics_blocking()?;
    if !diagnostics.qemu_img.available {
        return Err(
            "qemu-img est introuvable. Installe QEMU avant de creer un disque local.".to_string(),
        );
    }

    let architecture = normalize_arch(&payload.architecture);
    let system_binary = if architecture == "arm64" {
        diagnostics.qemu_system_arm64.path
    } else if architecture == "amd64" {
        diagnostics.qemu_system_amd64.path
    } else {
        None
    };
    if system_binary.is_none() {
        return Err(format!("QEMU system pour {} est introuvable", architecture));
    }

    if payload.cpu == 0 || payload.memory_mib < 128 || payload.disk_gib == 0 {
        return Err("CPU, RAM ou disque invalide".to_string());
    }

    let config = read_storage_config()?;
    ensure_storage_dirs(&config)?;
    let mut vms = read_local_vms()?;
    if vms
        .iter()
        .any(|vm| vm.name.eq_ignore_ascii_case(payload.name.trim()))
    {
        return Err("Une VM locale porte deja ce nom".to_string());
    }

    let safe_name = safe_file_name(&payload.name)?;
    let id = now_id();
    let disk_path = PathBuf::from(&config.disk_dir).join(format!("{}-{}.qcow2", safe_name, id));
    let qemu_img = diagnostics
        .qemu_img
        .path
        .ok_or_else(|| "qemu-img est introuvable".to_string())?;
    let size = format!("{}G", payload.disk_gib);
    let mut create_disk = platform::command(&qemu_img);
    create_disk
        .args(["create", "-f", "qcow2"])
        .arg(&disk_path)
        .arg(size);
    platform::output(create_disk, Duration::from_secs(120))
        .map_err(|err| format!("Creation du disque impossible: {}", err))?;

    let timestamp = now_string();
    let iso_path = payload
        .iso_path
        .clone()
        .filter(|value| !value.trim().is_empty());
    let vm = LocalVm {
        id,
        name: payload.name.trim().to_string(),
        architecture: architecture.clone(),
        cpu: payload.cpu,
        memory_mib: payload.memory_mib,
        disk_gib: payload.disk_gib,
        disk_path: disk_path.to_string_lossy().to_string(),
        iso_path: iso_path.clone(),
        network: normalize_network_mode(payload.network),
        network_model: normalize_network_model(payload.network_model),
        gpu_model: normalize_gpu_model(payload.gpu_model),
        disk_bus: normalize_disk_bus(
            &architecture,
            payload.disk_bus.or_else(|| {
                Some(default_disk_bus_for_new_vm(
                    &architecture,
                    iso_path.as_deref(),
                ))
            }),
        ),
        tpm2: payload.tpm2.unwrap_or(false),
        secure_boot: payload.secure_boot.unwrap_or(false),
        state: "stopped".to_string(),
        pid: None,
        vnc_port: None,
        spice_port: None,
        spice_password: None,
        qmp_port: None,
        qga_port: None,
        guest_ip: None,
        guest_agent_running: false,
        qga_last_probe_at: None,
        cpu_usage: None,
        memory_usage: None,
        uptime_seconds: None,
        startup_notes: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    vms.push(vm.clone());
    write_local_vms(&vms)?;
    Ok(vm)
}

#[tauri::command]
async fn local_update_vm(id: String, payload: LocalUpdateVmPayload) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_update_vm_blocking(id, payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_update_vm_blocking(id: String, payload: LocalUpdateVmPayload) -> Result<LocalVm, String> {
    let mut vms = read_local_vms()?;
    let index = vms
        .iter()
        .position(|vm| vm.id == id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    let mut vm = vms[index].clone();

    if let Some(name) = payload.name {
        let name = name.trim();
        if name.is_empty() {
            return Err("Nom de VM invalide".to_string());
        }
        if vms
            .iter()
            .any(|other| other.id != id && other.name.eq_ignore_ascii_case(name))
        {
            return Err("Une VM locale porte deja ce nom".to_string());
        }
        vm.name = name.to_string();
    }

    if let Some(image) = payload.image {
        let image = image.trim().to_string();
        vm.iso_path = if image.is_empty() { None } else { Some(image) };
    }

    if let Some(cpu) = payload.cpu {
        if cpu == 0 {
            return Err("CPU invalide".to_string());
        }
        vm.cpu = cpu;
    }

    if let Some(memory_mib) = payload.memory_mib {
        if memory_mib < 128 {
            return Err("RAM invalide".to_string());
        }
        vm.memory_mib = memory_mib;
    }

    if let Some(network) = payload.network {
        vm.network = normalize_network_mode(Some(network));
    }

    if let Some(network_model) = payload.network_model {
        vm.network_model = normalize_network_model(Some(network_model));
    }

    if let Some(gpu_model) = payload.gpu_model {
        vm.gpu_model = normalize_gpu_model(Some(gpu_model));
    }

    if let Some(disk_bus) = payload.disk_bus {
        if vm_process_alive(&vm) {
            return Err("Arrete la VM avant de changer le bus disque".to_string());
        }
        vm.disk_bus = normalize_disk_bus(&vm.architecture, Some(disk_bus));
    }

    if let Some(tpm2) = payload.tpm2 {
        vm.tpm2 = tpm2;
    }

    if let Some(secure_boot) = payload.secure_boot {
        vm.secure_boot = secure_boot;
    }

    vm.updated_at = now_string();
    vms[index] = vm.clone();
    write_local_vms(&vms)?;
    Ok(vm)
}

#[tauri::command]
async fn local_delete_vm(id: String, delete_disks: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        local_delete_vm_blocking(id, delete_disks)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn local_delete_vm_blocking(id: String, delete_disks: bool) -> Result<(), String> {
    let config = read_storage_config()?;
    let disk_root = PathBuf::from(&config.disk_dir);
    let mut vms = read_local_vms()?;
    let index = vms
        .iter()
        .position(|vm| vm.id == id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    let vm = vms.remove(index);

    if let Some(pid) = vm.pid {
        if let Some(qmp_port) = vm.qmp_port {
            let _ = qmp_execute(qmp_port, "quit");
        }
        // Deleting the disk while QEMU still holds it fails outright on Windows
        // and corrupts nothing but the user's expectations elsewhere: wait for
        // the process to go, then force it.
        for _ in 0..30 {
            if !vm_process_alive(&vm) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if vm_process_alive(&vm) {
            platform::terminate(pid)?;
            for _ in 0..20 {
                if !vm_process_alive(&vm) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    if delete_disks {
        let disk_path = PathBuf::from(&vm.disk_path);
        if disk_path.exists() && is_path_inside(&disk_path, &disk_root) {
            fs::remove_file(disk_path).map_err(|err| {
                format!(
                    "Suppression du disque impossible ({}). La VM est conservee.",
                    err
                )
            })?;
        }
    }

    write_local_vms(&vms)
}

#[tauri::command]
async fn local_delete_container(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(name) = id.strip_prefix("docker:") {
            safe_container_name(name)?;
            command_output("docker", &["rm", "-f", name]).map(|_| ())
        } else if let Some(name) = id.strip_prefix("lxc:") {
            safe_container_name(name)?;
            let _ = containers::output(&["stop", name, "--force"]);
            containers::output(&["delete", name]).map(|_| ())
        } else {
            Err("Ressource locale inconnue".to_string())
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Local, transport-agnostic TCP<->WebSocket relay. Binds an ephemeral local
/// port, accepts one-time-token-authenticated WS connections for 45s, and
/// pipes raw bytes both ways to `port` (VNC, SPICE, ... whatever speaks a
/// plain TCP protocol on 127.0.0.1). Returns the `ws://` URL to connect to.
async fn spawn_tcp_ws_relay(port: u16) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| err.to_string())?;
    let proxy_port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let token = random_token();
    let expected_path = format!("/{}", token);

    tauri::async_runtime::spawn(async move {
        let expires_at = tokio::time::Instant::now() + tokio::time::Duration::from_secs(45);
        loop {
            let Some(remaining) = expires_at.checked_duration_since(tokio::time::Instant::now())
            else {
                break;
            };
            let Ok(accept_result) = tokio::time::timeout(remaining, listener.accept()).await else {
                break;
            };
            let Ok((stream, _)) = accept_result else {
                break;
            };

            let expected_path = expected_path.clone();
            tauri::async_runtime::spawn(async move {
                let callback =
                    |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                        if req.uri().path() != expected_path {
                            let denied = tokio_tungstenite::tungstenite::http::Response::builder()
                                .status(403)
                                .body(Some("Forbidden".to_string()))
                                .expect("reponse 403 valide");
                            return Err(denied);
                        }
                        negotiate_binary_protocol(req, response)
                    };
                let Ok(websocket) = tokio_tungstenite::accept_hdr_async(stream, callback).await
                else {
                    return;
                };
                let Ok(tcp) = connect_local_port_with_retry(port).await else {
                    return;
                };

                let (mut ws_write, mut ws_read) = websocket.split();
                let (mut tcp_read, mut tcp_write) = tcp.into_split();

                let ws_to_tcp = async {
                    while let Some(message) = ws_read.next().await {
                        match message {
                            Ok(Message::Binary(data)) => {
                                if tcp_write.write_all(&data).await.is_err() {
                                    break;
                                }
                            }
                            Ok(Message::Text(text)) => {
                                if tcp_write.write_all(text.as_str().as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            Ok(Message::Close(_)) | Err(_) => break,
                            _ => {}
                        }
                    }
                };

                let tcp_to_ws = async {
                    let mut buffer = [0_u8; 8192];
                    loop {
                        let Ok(size) = tcp_read.read(&mut buffer).await else {
                            break;
                        };
                        if size == 0 {
                            break;
                        }
                        if ws_write
                            .send(Message::Binary(buffer[..size].to_vec().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                };

                tokio::select! {
                    _ = ws_to_tcp => {},
                    _ = tcp_to_ws => {},
                }
            });
        }
    });

    Ok(format!("ws://127.0.0.1:{}/{}", proxy_port, token))
}

/// Reading the inventory touches the filesystem and probes processes; doing it
/// straight from an async command stalled a Tokio worker on every console open.
async fn running_vm(id: String) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        let vms = read_local_vms()?;
        let vm = vms
            .into_iter()
            .find(|vm| vm.id == id)
            .ok_or_else(|| "VM locale introuvable".to_string())?;
        if vm.state != "running" {
            return Err("La VM doit etre demarree pour ouvrir la console.".to_string());
        }
        Ok(vm)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn local_console_url(id: String) -> Result<String, String> {
    let vm = running_vm(id).await?;
    let vnc_port = vm.vnc_port.ok_or_else(|| "Cette VM a ete lancee avec l'ancien mode console. Redemarre-la pour utiliser la console integree.".to_string())?;
    spawn_tcp_ws_relay(vnc_port).await
}

#[tauri::command]
async fn local_spice_console_url(id: String) -> Result<serde_json::Value, String> {
    let vm = running_vm(id).await?;
    let spice_port = vm.spice_port.ok_or_else(|| {
        vm.startup_notes
            .clone()
            .unwrap_or_else(|| "SPICE n'est pas actif pour cette VM (redemarre-la).".to_string())
    })?;
    let password = vm.spice_password.clone().unwrap_or_default();
    let url = spawn_tcp_ws_relay(spice_port).await?;
    Ok(serde_json::json!({ "url": url, "password": password }))
}

fn text_console_command(id: &str) -> Result<tokio::process::Command, String> {
    let (kind, name) = id
        .split_once(':')
        .ok_or_else(|| "Console texte locale disponible seulement pour Docker/LXC".to_string())?;
    let name = safe_container_name(name)?;
    match kind {
        "docker" => {
            if find_binary("docker").is_none() {
                return Err("Docker CLI introuvable".to_string());
            }
            let mut command = tokio::process::Command::from(docker::command()?);
            command
                .arg("exec")
                .arg("-i")
                .arg(&name)
                .arg("sh")
                .arg("-lc")
                .arg("if command -v bash >/dev/null 2>&1; then exec bash -li; else exec sh -i; fi");
            Ok(command)
        }
        "lxc" => {
            let command = containers::command(&[
                "exec",
                &name,
                "--",
                "sh",
                "-lc",
                "if command -v bash >/dev/null 2>&1; then exec bash -li; else exec sh -i; fi",
            ])?;
            Ok(tokio::process::Command::from(command))
        }
        _ => Err("Console texte locale disponible seulement pour Docker/LXC".to_string()),
    }
}

#[tauri::command]
async fn local_text_console_url(id: String) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| err.to_string())?;
    let proxy_port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let token = random_token();
    let expected_path = format!("/{}", token);

    tauri::async_runtime::spawn(async move {
        let expires_at = tokio::time::Instant::now() + tokio::time::Duration::from_secs(45);
        loop {
            let Some(remaining) = expires_at.checked_duration_since(tokio::time::Instant::now())
            else {
                break;
            };
            let Ok(accept_result) = tokio::time::timeout(remaining, listener.accept()).await else {
                break;
            };
            let Ok((stream, _)) = accept_result else {
                break;
            };

            let expected_path = expected_path.clone();
            let id = id.clone();
            tauri::async_runtime::spawn(async move {
                let callback =
                    |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                        if req.uri().path() != expected_path {
                            let denied = tokio_tungstenite::tungstenite::http::Response::builder()
                                .status(403)
                                .body(Some("Forbidden".to_string()))
                                .expect("reponse 403 valide");
                            return Err(denied);
                        }
                        Ok(response)
                    };
                let Ok(websocket) = tokio_tungstenite::accept_hdr_async(stream, callback).await
                else {
                    return;
                };

                let mut command = match text_console_command(&id) {
                    Ok(command) => command,
                    Err(message) => {
                        let (mut write, _) = websocket.split();
                        let _ = write.send(Message::Text(serde_json::json!({ "type": "output", "data": format!("{}\r\n", message) }).to_string().into())).await;
                        let _ = write.close().await;
                        return;
                    }
                };
                command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                let Ok(mut child) = command.spawn() else {
                    let (mut write, _) = websocket.split();
                    let _ = write.send(Message::Text(serde_json::json!({ "type": "output", "data": "Impossible de lancer la console locale\r\n" }).to_string().into())).await;
                    let _ = write.close().await;
                    return;
                };

                let Some(mut child_stdin) = child.stdin.take() else {
                    let _ = child.kill().await;
                    return;
                };
                let Some(mut child_stdout) = child.stdout.take() else {
                    let _ = child.kill().await;
                    return;
                };
                let Some(mut child_stderr) = child.stderr.take() else {
                    let _ = child.kill().await;
                    return;
                };

                let (mut ws_write, mut ws_read) = websocket.split();
                let (output_tx, mut output_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
                let stdout_tx = output_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buffer = [0_u8; 2048];
                    loop {
                        let Ok(size) = child_stdout.read(&mut buffer).await else {
                            break;
                        };
                        if size == 0 {
                            break;
                        }
                        let _ =
                            stdout_tx.send(String::from_utf8_lossy(&buffer[..size]).to_string());
                    }
                });
                let stderr_tx = output_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buffer = [0_u8; 2048];
                    loop {
                        let Ok(size) = child_stderr.read(&mut buffer).await else {
                            break;
                        };
                        if size == 0 {
                            break;
                        }
                        let _ =
                            stderr_tx.send(String::from_utf8_lossy(&buffer[..size]).to_string());
                    }
                });

                let ws_to_process = async {
                    while let Some(message) = ws_read.next().await {
                        let Ok(message) = message else {
                            break;
                        };
                        match message {
                            Message::Text(text) => {
                                let data = serde_json::from_str::<serde_json::Value>(&text)
                                    .ok()
                                    .and_then(|value| {
                                        value
                                            .get("data")
                                            .and_then(|data| data.as_str())
                                            .map(str::to_string)
                                    })
                                    .unwrap_or_else(|| text.to_string());
                                if child_stdin.write_all(data.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            Message::Binary(data) => {
                                if child_stdin.write_all(&data).await.is_err() {
                                    break;
                                }
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                };

                let process_to_ws = async {
                    while let Some(data) = output_rx.recv().await {
                        let payload =
                            serde_json::json!({ "type": "output", "data": data }).to_string();
                        if ws_write.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                };

                tokio::select! {
                    _ = ws_to_process => {},
                    _ = process_to_ws => {},
                    _ = child.wait() => {},
                }
                let _ = child.kill().await;
            });
        }
    });

    Ok(format!("ws://127.0.0.1:{}/{}", proxy_port, token))
}

/// How the SPICE session is authenticated. `password-secret` is the modern
/// form; `password=` still exists on older builds, and some Windows packages
/// ship QEMU without SPICE at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpiceMode {
    Secret,
    Inline,
    Off,
}

/// One attempt at launching a VM. Features are dropped one at a time when a
/// build of QEMU (or a host) cannot provide them, instead of leaving the user
/// with a VM that "does not start" and no explanation.
#[derive(Clone, Debug, PartialEq, Eq)]
struct LaunchPlan {
    accelerator: String,
    spice: SpiceMode,
    audio: bool,
    usb_tablet: bool,
    gpu_model: String,
    note: Option<&'static str>,
}

/// The degradation ladder, most capable first. A failed attempt costs almost
/// nothing (QEMU rejects an unknown option in milliseconds), so trying the
/// full feature set first is free.
fn launch_plans(architecture: &str, gpu_model: &str) -> Vec<LaunchPlan> {
    let chain = platform::accelerator_chain(architecture);
    let preferred = chain.first().cloned().unwrap_or_else(|| "tcg".to_string());
    let base = LaunchPlan {
        accelerator: preferred.clone(),
        spice: SpiceMode::Secret,
        audio: true,
        usb_tablet: true,
        gpu_model: gpu_model.to_string(),
        note: None,
    };
    let mut plans = vec![
        base.clone(),
        LaunchPlan {
            spice: SpiceMode::Inline,
            note: Some("QEMU ancien: mot de passe SPICE transmis en ligne"),
            ..base.clone()
        },
        LaunchPlan {
            audio: false,
            note: Some("audio SPICE indisponible sur cette installation de QEMU"),
            ..base.clone()
        },
        LaunchPlan {
            spice: SpiceMode::Off,
            audio: false,
            note: Some("SPICE indisponible sur cette installation de QEMU (console VNC utilisee)"),
            ..base.clone()
        },
        LaunchPlan {
            spice: SpiceMode::Off,
            audio: false,
            gpu_model: "std".to_string(),
            note: Some("carte graphique virtio indisponible (VGA standard utilisee)"),
            ..base.clone()
        },
        LaunchPlan {
            spice: SpiceMode::Off,
            audio: false,
            usb_tablet: false,
            gpu_model: "std".to_string(),
            note: Some("peripheriques USB emules indisponibles (pointeur relatif)"),
            ..base.clone()
        },
    ];
    for fallback in chain.into_iter().skip(1) {
        plans.push(LaunchPlan {
            accelerator: fallback,
            spice: SpiceMode::Off,
            audio: false,
            usb_tablet: false,
            gpu_model: "std".to_string(),
            note: Some(
                "acceleration materielle indisponible: la VM tourne en emulation logicielle (TCG)",
            ),
        });
    }
    plans
}

struct LaunchPorts {
    vnc_display: u16,
    spice_port: u16,
    spice_password: String,
    qmp_port: u16,
    qga_port: u16,
}

fn build_qemu_command(
    qemu_path: &str,
    vm: &LocalVm,
    ports: &LaunchPorts,
    plan: &LaunchPlan,
) -> Result<Command, String> {
    let mut command = platform::command(qemu_path);
    command
        .arg("-name")
        .arg(&vm.id)
        .arg("-m")
        .arg(vm.memory_mib.to_string())
        .arg("-smp")
        .arg(vm.cpu.to_string());

    platform::machine_args(&mut command, &vm.architecture, &plan.accelerator);
    if vm.architecture == "arm64" {
        let firmware = find_qemu_firmware(&vm.architecture).ok_or(
            "Firmware ARM64 QEMU absent (EDK2/AAVMF). Installez QEMU depuis Configuration.",
        )?;
        command.arg("-bios").arg(firmware);
        // `virt` has no built-in input: without a USB controller an ARM64 guest
        // has neither keyboard nor mouse in the console.
        command.args(["-device", "qemu-xhci", "-device", "usb-kbd"]);
        if plan.usb_tablet {
            command.args(["-device", "usb-tablet"]);
        }
    } else if plan.usb_tablet {
        // An absolute pointing device is what keeps the VNC/SPICE cursor
        // aligned with the guest cursor.
        command.args(["-device", "usb-ehci", "-device", "usb-tablet"]);
    }

    append_disk_args(&mut command, &vm.disk_path, &vm.disk_bus);
    append_gpu_args(&mut command, &vm.architecture, &plan.gpu_model);
    append_network_args(
        &mut command,
        &vm.architecture,
        &vm.network,
        &vm.network_model,
    );

    // Guest agent over loopback TCP: identical on macOS, Linux and Windows.
    command
        .arg("-chardev")
        .arg(format!(
            "socket,host=127.0.0.1,port={},server=on,wait=off,id=qga0",
            ports.qga_port
        ))
        .args([
            "-device",
            "virtio-serial-pci",
            "-device",
            "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
        ]);

    match plan.spice {
        SpiceMode::Secret => {
            command.arg("-object").arg(format!(
                "secret,id=virtua-spice-secret,data={}",
                ports.spice_password
            ));
            command.arg("-spice").arg(format!(
                "port={},addr=127.0.0.1,disable-ticketing=off,password-secret=virtua-spice-secret",
                ports.spice_port
            ));
        }
        SpiceMode::Inline => {
            command.arg("-spice").arg(format!(
                "port={},addr=127.0.0.1,disable-ticketing=off,password={}",
                ports.spice_port, ports.spice_password
            ));
        }
        SpiceMode::Off => {}
    }
    if plan.audio {
        // `hda-duplex` is a codec: without its `intel-hda` controller QEMU
        // refuses to start with "No 'HDA bus' bus found".
        command
            .arg("-audiodev")
            .arg("spice,id=audioSpice")
            .arg("-device")
            .arg("intel-hda")
            .arg("-device")
            .arg("hda-duplex,audiodev=audioSpice");
    }

    if let Some(iso_path) = &vm.iso_path {
        if !iso_path.trim().is_empty() {
            if iso_path.contains(',') || iso_path.contains('\n') || iso_path.contains('\r') {
                return Err("Chemin ISO invalide".to_string());
            }
            // `order=dc` falls through to the disk when the ISO is not
            // bootable, instead of the old `-boot d` which pinned the VM to a
            // CD-ROM it could never leave.
            command
                .arg("-cdrom")
                .arg(iso_path)
                .arg("-boot")
                .arg("order=dc,menu=on");
        }
    }

    command
        .arg("-display")
        .arg("none")
        .arg("-vnc")
        .arg(format!(
            "127.0.0.1:{},share=force-shared",
            ports.vnc_display
        ))
        .arg("-qmp")
        .arg(format!(
            "tcp:127.0.0.1:{},server=on,wait=off",
            ports.qmp_port
        ));
    Ok(command)
}

/// Give QEMU time to fail: reading the log after 350 ms reported "started" for
/// commands that died a second later (a missing accelerator on Windows is the
/// usual case), leaving a phantom running VM in the inventory.
fn wait_for_qemu(child: &mut std::process::Child) -> Result<(), String> {
    let deadline = std::time::Instant::now() + Duration::from_millis(2500);
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Err(status.to_string()),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(())
}

fn start_local_vm(vm: &mut LocalVm, others: &[LocalVm]) -> Result<(), String> {
    let diagnostics = qemu_diagnostics_blocking()?;
    let qemu_path = match vm.architecture.as_str() {
        "arm64" => diagnostics.qemu_system_arm64.path,
        "amd64" => diagnostics.qemu_system_amd64.path,
        _ => None,
    }
    .ok_or_else(|| {
        format!(
            "QEMU system pour {} est introuvable. Installez-le depuis Configuration → Moteurs locaux.",
            vm.architecture
        )
    })?;

    if !Path::new(&vm.disk_path).is_file() {
        return Err(format!("Disque introuvable: {}", vm.disk_path));
    }
    // QEMU splits drive/cdrom options on commas.
    if vm.disk_path.contains(',') {
        return Err("Chemin de disque invalide (',' non autorise)".to_string());
    }

    let reserved = |pick: fn(&LocalVm) -> Option<u16>| -> Vec<u16> {
        others.iter().filter_map(pick).collect()
    };
    let vnc_port = find_free_port_excluding(5901, 5999, &reserved(|vm| vm.vnc_port))
        .ok_or_else(|| "Aucun port console local disponible".to_string())?;
    let qmp_port = find_free_port_excluding(6001, 6099, &reserved(|vm| vm.qmp_port))
        .ok_or_else(|| "Aucun port controle QEMU local disponible".to_string())?;
    let spice_port = find_free_port_excluding(5701, 5799, &reserved(|vm| vm.spice_port))
        .ok_or_else(|| "Aucun port SPICE local disponible".to_string())?;
    let qga_port = find_free_port_excluding(6201, 6299, &reserved(|vm| vm.qga_port))
        .ok_or_else(|| "Aucun port agent invite disponible".to_string())?;
    let ports = LaunchPorts {
        vnc_display: vnc_port - 5900,
        spice_port,
        spice_password: random_token(),
        qmp_port,
        qga_port,
    };

    let log_dir = local_state_dir()?.join("Logs");
    fs::create_dir_all(&log_dir).map_err(|err| err.to_string())?;
    let log_path = log_dir.join(format!("{}-qemu.log", safe_file_name(&vm.name)?));
    // Keep only the last run: the log is what the fallback ladder reports on.
    let _ = fs::write(&log_path, b"");

    let mut notes: Vec<String> = vec![];
    if vm.tpm2 {
        notes.push("TPM 2.0 n'est pas emule en mode local (option ignoree)".to_string());
    }
    let mut failures: Vec<String> = vec![];

    for plan in launch_plans(&vm.architecture, &vm.gpu_model) {
        let mut command = build_qemu_command(&qemu_path, vm, &ports, &plan)?;
        let log_file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|err| format!("Log QEMU impossible: {}", err))?;
        let log_error = log_file
            .try_clone()
            .map_err(|err| format!("Log QEMU impossible: {}", err))?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_error));

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                failures.push(format!("Lancement QEMU impossible: {}", err));
                continue;
            }
        };
        match wait_for_qemu(&mut child) {
            Ok(()) => {
                if let Some(note) = plan.note {
                    notes.push(note.to_string());
                }
                vm.pid = Some(child.id());
                vm.vnc_port = Some(vnc_port);
                let spice_enabled = plan.spice != SpiceMode::Off;
                vm.spice_port = spice_enabled.then_some(spice_port);
                vm.spice_password = spice_enabled.then(|| ports.spice_password.clone());
                vm.qmp_port = Some(qmp_port);
                vm.qga_port = Some(qga_port);
                vm.guest_ip = None;
                vm.guest_agent_running = false;
                vm.qga_last_probe_at = None;
                vm.cpu_usage = Some(0.0);
                vm.memory_usage = Some(0.0);
                vm.uptime_seconds = Some(0);
                vm.state = "running".to_string();
                vm.startup_notes = (!notes.is_empty()).then(|| notes.join(" · "));
                vm.updated_at = now_string();
                return Ok(());
            }
            Err(status) => {
                let details = tail_file(&log_path, 1200)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(status);
                failures.push(details);
                let _ = fs::write(&log_path, b"");
            }
        }
    }

    Err(format!(
        "QEMU a quitte au demarrage, y compris apres repli sans SPICE/audio et sans accélération. Dernier journal: {}",
        failures.last().cloned().unwrap_or_default()
    ))
}

fn stop_local_vm_fields(vm: &mut LocalVm) {
    vm.pid = None;
    vm.vnc_port = None;
    vm.spice_port = None;
    vm.spice_password = None;
    vm.qmp_port = None;
    clear_vm_guest_agent_state(vm);
    vm.cpu_usage = None;
    vm.memory_usage = None;
    vm.uptime_seconds = None;
    vm.state = "stopped".to_string();
    vm.updated_at = now_string();
}

fn run_vm_action(id: &str, action: &str) -> Result<LocalVm, String> {
    let mut vms = read_local_vms()?;
    let index = vms
        .iter()
        .position(|vm| vm.id == id)
        .ok_or_else(|| "VM locale introuvable".to_string())?;
    let mut vm = vms[index].clone();

    match action {
        "start" => {
            if vm_process_alive(&vm) {
                return Ok(vm);
            }
            let others: Vec<LocalVm> = vms
                .iter()
                .filter(|other| other.id != vm.id)
                .cloned()
                .collect();
            // Persist the stopped state before a long start attempt so a crash
            // mid-launch cannot leave a bogus PID behind.
            start_local_vm(&mut vm, &others)?;
        }
        "shutdown" => {
            if !vm_process_alive(&vm) {
                stop_local_vm_fields(&mut vm);
            } else if let Some(qmp_port) = vm.qmp_port {
                qmp_execute(qmp_port, "system_powerdown")?;
                vm.state = "stopping".to_string();
                vm.updated_at = now_string();
            } else {
                return Err("Cette VM a ete lancee sans controle QMP. Redemarre-la pour utiliser l'arret propre.".to_string());
            }
        }
        "stop" => {
            if let Some(pid) = vm.pid {
                if let Some(qmp_port) = vm.qmp_port {
                    let _ = qmp_execute(qmp_port, "quit");
                }
                // QMP `quit` is best-effort: make sure the process is really gone.
                for _ in 0..20 {
                    if !vm_process_alive(&vm) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if vm_process_alive(&vm) {
                    platform::terminate(pid)?;
                }
            }
            stop_local_vm_fields(&mut vm);
        }
        "restart" => {
            if let Some(pid) = vm.pid {
                if let Some(qmp_port) = vm.qmp_port {
                    let _ = qmp_execute(qmp_port, "quit");
                }
                for _ in 0..30 {
                    if !vm_process_alive(&vm) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if vm_process_alive(&vm) {
                    platform::terminate(pid)?;
                }
            }
            stop_local_vm_fields(&mut vm);
            vms[index] = vm;
            write_local_vms(&vms)?;
            std::thread::sleep(Duration::from_millis(700));
            return run_vm_action(id, "start");
        }
        _ => return Err("Action locale inconnue".to_string()),
    }

    vms[index] = vm.clone();
    write_local_vms(&vms)?;
    Ok(vm)
}

#[tauri::command]
async fn local_run_action(id: String, action: String) -> Result<LocalVm, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = inventory_guard();
        run_vm_action(&id, &action)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn local_run_container_action(
    id: String,
    action: String,
) -> Result<LocalContainerResource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (kind, name) = id
            .split_once(':')
            .ok_or_else(|| "Ressource locale inconnue".to_string())?;
        safe_container_name(name)?;
        match kind {
            "docker" => {
                let docker_action = match action.as_str() {
                    "start" => "start",
                    "restart" => "restart",
                    "shutdown" | "stop" => "stop",
                    _ => return Err("Action Docker inconnue".to_string()),
                };
                command_output("docker", &[docker_action, name])?;
                list_docker_resources()
                    .into_iter()
                    .find(|resource| resource.name == name)
                    .ok_or_else(|| "Conteneur Docker introuvable".to_string())
            }
            "lxc" => {
                match action.as_str() {
                    "start" => {
                        containers::output(&["start", name])?;
                    }
                    "restart" => {
                        containers::output(&["restart", name])?;
                    }
                    "shutdown" => {
                        containers::output(&["stop", name])?;
                    }
                    "stop" => {
                        containers::output(&["stop", name, "--force"])?;
                    }
                    _ => return Err("Action LXC inconnue".to_string()),
                }
                list_lxc_resources()
                    .into_iter()
                    .find(|resource| resource.name == name)
                    .ok_or_else(|| "Conteneur LXC introuvable".to_string())
            }
            _ => Err("Ressource locale inconnue".to_string()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Append one line to `<data dir>/Logs/desktop.log`. Windows gives no console
/// and no crash report for a packaged Tauri app: without this, "ça plante" was
/// unreproducible.
fn log_line(message: &str) {
    let Ok(dir) = local_state_dir().map(|dir| dir.join("Logs")) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("desktop.log");
    // Keep the log bounded so it can never fill the user's disk.
    if fs::metadata(&path)
        .map(|m| m.len() > 2 * 1024 * 1024)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, dir.join("desktop.log.1"));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{}] {}", now_string(), message);
    }
}

fn install_crash_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        log_line(&format!("PANIC {location} — {payload}"));
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_crash_log();
    log_line(&format!(
        "demarrage {} {} sur {}/{}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        env::consts::OS,
        env::consts::ARCH
    ));
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_refresh_token,
            load_refresh_token,
            clear_refresh_token,
            save_desktop_setting,
            load_desktop_setting,
            clear_desktop_setting,
            runtime_platform,
            local_host_metrics,
            local_qemu_diagnostics,
            local_load_storage_config,
            local_save_storage_config,
            local_storage_inventory,
            local_list_remote_templates,
            local_download_template,
            local_import_vm_template,
            local_export_vm_template,
            local_delete_storage_file,
            local_list_snapshots,
            local_create_snapshot,
            local_delete_snapshot,
            local_rollback_snapshot,
            local_list_vms,
            local_list_containers,
            local_create_vm,
            local_create_container,
            local_update_vm,
            local_delete_vm,
            local_delete_container,
            local_console_url,
            local_spice_console_url,
            local_text_console_url,
            local_run_action,
            local_run_container_action,
            engines::local_engine_status,
            engines::local_prepare_engine,
            companion::local_stop_lxc_vm,
            companion::local_lxc_logs,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            log_line(&format!("arret fatal: {error}"));
            // On Windows this is almost always a missing WebView2 runtime.
            panic!("AuxiNux Virtua Desktop n'a pas pu demarrer: {error}");
        });
}

#[cfg(test)]
mod local_mode_tests {
    use super::*;

    #[test]
    fn every_launch_ladder_ends_without_optional_features() {
        let plans = launch_plans("amd64", "virtio");
        let first = plans.first().expect("at least one plan");
        assert_eq!(first.spice, SpiceMode::Secret);
        assert!(first.audio && first.usb_tablet);
        assert_eq!(first.gpu_model, "virtio");

        let last = plans.last().expect("at least one plan");
        assert_eq!(last.spice, SpiceMode::Off);
        assert!(!last.audio);
        assert_eq!(last.gpu_model, "std");
        // Only the first attempt is silent; every degradation is explained.
        assert!(plans.iter().skip(1).all(|plan| plan.note.is_some()));
    }

    #[test]
    fn audio_always_carries_its_hda_controller() {
        let vm = sample_vm("amd64", "virtio");
        let ports = sample_ports();
        let plan = launch_plans("amd64", "virtio").remove(0);
        let args = command_args(&build_qemu_command("qemu", &vm, &ports, &plan).unwrap());
        let hda = args
            .iter()
            .position(|a| a == "intel-hda")
            .expect("controller");
        let codec = args
            .iter()
            .position(|a| a.starts_with("hda-duplex"))
            .expect("codec");
        assert!(hda < codec, "the codec needs its bus declared first");
    }

    #[test]
    fn a_spice_less_plan_emits_no_spice_option() {
        let vm = sample_vm("amd64", "virtio");
        let ports = sample_ports();
        let plan = LaunchPlan {
            accelerator: "tcg".into(),
            spice: SpiceMode::Off,
            audio: false,
            usb_tablet: false,
            gpu_model: "std".into(),
            note: None,
        };
        let args = command_args(&build_qemu_command("qemu", &vm, &ports, &plan).unwrap());
        assert!(!args.iter().any(|a| a == "-spice"));
        assert!(!args.iter().any(|a| a == "-audiodev"));
        // The guest agent and the VNC console stay available in every plan.
        assert!(args.iter().any(|a| a.contains("org.qemu.guest_agent.0")));
        assert!(args.iter().any(|a| a == "-vnc"));
    }

    #[test]
    fn the_spice_password_never_leaks_on_the_command_line_by_default() {
        let vm = sample_vm("amd64", "virtio");
        let ports = sample_ports();
        let plan = launch_plans("amd64", "virtio").remove(0);
        let args = command_args(&build_qemu_command("qemu", &vm, &ports, &plan).unwrap());
        assert!(args
            .iter()
            .any(|a| a.contains("password-secret=virtua-spice-secret")));
    }

    #[test]
    fn an_iso_boot_falls_back_to_the_disk() {
        let mut vm = sample_vm("amd64", "virtio");
        vm.iso_path = Some("/tmp/installer.iso".into());
        let plan = launch_plans("amd64", "virtio").remove(0);
        let args = command_args(&build_qemu_command("qemu", &vm, &sample_ports(), &plan).unwrap());
        assert!(args.iter().any(|a| a == "order=dc,menu=on"));
    }

    #[test]
    fn arm64_disks_are_always_virtio() {
        assert_eq!(normalize_disk_bus("arm64", Some("sata".into())), "virtio");
        assert_eq!(normalize_disk_bus("amd64", Some("sata".into())), "sata");
        assert_eq!(normalize_disk_bus("amd64", None), "virtio");
    }

    #[test]
    fn x86_installers_get_a_bus_their_drivers_know() {
        assert_eq!(
            default_disk_bus_for_new_vm("amd64", Some("/iso/debian.iso")),
            "sata"
        );
        assert_eq!(default_disk_bus_for_new_vm("amd64", None), "virtio");
        assert_eq!(
            default_disk_bus_for_new_vm("arm64", Some("/iso/debian.iso")),
            "virtio"
        );
    }

    #[test]
    fn a_sata_disk_declares_its_controller() {
        let mut cmd = Command::new("qemu");
        append_disk_args(&mut cmd, "/disks/vm.qcow2", "sata");
        let args = command_args(&cmd);
        assert!(args.iter().any(|a| a.starts_with("ich9-ahci")));
        assert!(args.iter().any(|a| a.contains("bus=virtua-ahci.0")));
    }

    #[test]
    fn templates_round_trip_without_the_system_tar() {
        let root = env::temp_dir().join(format!("virtua-tar-{}", random_token()));
        let work = root.join("work");
        fs::create_dir_all(&work).unwrap();
        fs::write(work.join("config.virtua"), "[CONFIG]\nDISK=disk.qcow2\n").unwrap();
        fs::write(work.join("disk.qcow2"), b"not-really-a-disk").unwrap();
        let archive = root.join("template.tar.gz");
        create_tar_gz(&archive, &work, &["config.virtua", "disk.qcow2"]).unwrap();

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        extract_tar_gz(&archive, &out).unwrap();
        assert_eq!(
            fs::read(out.join("disk.qcow2")).unwrap(),
            b"not-really-a-disk"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_traversing_archive_entry_is_refused() {
        assert!(!tar_entry_is_safe(Path::new("../escaped.txt")));
        assert!(!tar_entry_is_safe(Path::new("nested/../../escaped.txt")));
        assert!(!tar_entry_is_safe(Path::new("/etc/passwd")));
        assert!(tar_entry_is_safe(Path::new("config.virtua")));
        assert!(tar_entry_is_safe(Path::new("./disks/disk.qcow2")));
    }

    #[test]
    fn an_interrupted_write_never_truncates_the_inventory() {
        let dir = env::temp_dir().join(format!("virtua-json-{}", random_token()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        write_json_atomic(&path, "[1]").unwrap();
        write_json_atomic(&path, "[1,2]").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1,2]");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_file_names_stay_inside_the_download_directory() {
        // A hostile listing entry is reduced to its final component.
        assert_eq!(safe_download_name("../../etc/passwd").unwrap(), "passwd");
        assert!(safe_download_name("..").is_err());
        assert!(safe_download_name("   ").is_err());
        assert_eq!(safe_download_name(" debian.iso ").unwrap(), "debian.iso");
    }

    fn sample_vm(architecture: &str, gpu_model: &str) -> LocalVm {
        LocalVm {
            id: "local-vm-1".into(),
            name: "Test".into(),
            architecture: architecture.into(),
            cpu: 2,
            memory_mib: 2048,
            disk_gib: 20,
            disk_path: "/disks/vm.qcow2".into(),
            iso_path: None,
            network: "user".into(),
            network_model: "virtio".into(),
            gpu_model: gpu_model.into(),
            disk_bus: "virtio".into(),
            tpm2: false,
            secure_boot: false,
            state: "stopped".into(),
            pid: None,
            vnc_port: None,
            spice_port: None,
            spice_password: None,
            qmp_port: None,
            qga_port: None,
            guest_ip: None,
            guest_agent_running: false,
            qga_last_probe_at: None,
            cpu_usage: None,
            memory_usage: None,
            uptime_seconds: None,
            startup_notes: None,
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }

    fn sample_ports() -> LaunchPorts {
        LaunchPorts {
            vnc_display: 1,
            spice_port: 5701,
            spice_password: "secret".into(),
            qmp_port: 6001,
            qga_port: 6201,
        }
    }

    fn command_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }
}
