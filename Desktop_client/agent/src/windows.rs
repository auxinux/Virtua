//! Windows side: the service, its virtio-serial port, and what the protocol
//! asks of the system.

use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl,
    ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState,
    ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{GetAdaptersAddresses, IP_ADAPTER_ADDRESSES_LH};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, OPEN_EXISTING};
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

use crate::protocol::{self, ExecResult, LineBuffer, Platform};

pub const SERVICE_NAME: &str = "VirtuaAgent";
const DISPLAY_NAME: &str = "Agent Virtua";
const PORT_PATH: &str = r"\\.\Global\org.auxinux.virtua.0";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

// ── The port ────────────────────────────────────────────────────────────────

/// An overlapped handle: one thread reads while others write.
pub struct Port {
    handle: HANDLE,
    write_lock: Mutex<()>,
}

// The handle is a kernel object usable from any thread.
unsafe impl Send for Port {}
unsafe impl Sync for Port {}

impl Port {
    fn open() -> Option<Port> {
        let path = wide(PORT_PATH);
        let handle = unsafe {
            CreateFileW(path.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut())
        };
        (handle != INVALID_HANDLE_VALUE && !handle.is_null()).then_some(Port { handle, write_lock: Mutex::new(()) })
    }

    /// One overlapped transfer, waited for. `write` picks WriteFile.
    fn transfer(&self, buffer: *mut u8, len: u32, write: bool) -> Result<u32, u32> {
        unsafe {
            let event = CreateEventW(std::ptr::null(), 1, 0, std::ptr::null());
            if event.is_null() {
                return Err(GetLastError());
            }
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            overlapped.hEvent = event;
            let mut done = 0u32;
            let started = if write {
                WriteFile(self.handle, buffer, len, &mut done, &mut overlapped)
            } else {
                ReadFile(self.handle, buffer, len, &mut done, &mut overlapped)
            };
            let result = if started != 0 {
                Ok(done)
            } else if GetLastError() == ERROR_IO_PENDING {
                if GetOverlappedResult(self.handle, &overlapped, &mut done, 1) != 0 { Ok(done) } else { Err(GetLastError()) }
            } else {
                Err(GetLastError())
            };
            CloseHandle(event);
            result
        }
    }

    fn read(&self, buffer: &mut [u8]) -> Result<usize, u32> {
        self.transfer(buffer.as_mut_ptr(), buffer.len() as u32, false).map(|n| n as usize)
    }

    fn write_all(&self, data: &[u8]) -> Result<(), u32> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut offset = 0;
        while offset < data.len() {
            let chunk = (data.len() - offset).min(64 * 1024);
            let n = self.transfer(data[offset..].as_ptr() as *mut u8, chunk as u32, true)? as usize;
            if n == 0 {
                return Err(0);
            }
            offset += n;
        }
        Ok(())
    }

    fn cancel(&self) {
        unsafe {
            CancelIoEx(self.handle, std::ptr::null());
        }
    }
}

impl Drop for Port {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// Serve the port until `stop`: reopen it whenever it goes away (the VM
/// started without the port, the Desktop restarted QEMU…).
pub fn serve(stop: &AtomicBool, current: &Mutex<Option<Arc<Port>>>) {
    let platform: Arc<WindowsPlatform> = Arc::new(WindowsPlatform::new());
    while !stop.load(Ordering::SeqCst) {
        let Some(port) = Port::open() else {
            std::thread::sleep(Duration::from_secs(3));
            continue;
        };
        let port = Arc::new(port);
        *current.lock().unwrap_or_else(|e| e.into_inner()) = Some(port.clone());
        {
            // Announce ourselves; a write may wait for the host to connect.
            let port = port.clone();
            let hello = format!("{}\n", json!({ "event": "hello", "hello": protocol::hello(platform.as_ref()) }));
            std::thread::spawn(move || {
                let _ = port.write_all(hello.as_bytes());
            });
        }
        let mut lines = LineBuffer::default();
        let mut buffer = vec![0u8; 64 * 1024];
        // A read fails while nobody listens on the host side (Virtua
        // Desktop closed, VM still running). Keep the port and read again:
        // closing it left the pending hello write holding the (exclusive)
        // port, and the agent never read anything after the host came back.
        let mut failures = 0u32;
        while !stop.load(Ordering::SeqCst) {
            match port.read(&mut buffer) {
                Ok(0) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) if failures < 60 => {
                    failures += 1;
                    std::thread::sleep(Duration::from_millis(500));
                }
                Ok(n) => {
                    failures = 0;
                    for line in lines.push(&buffer[..n]) {
                        let Some(request) = protocol::parse(&line) else { continue };
                        let (port, platform) = (port.clone(), platform.clone());
                        // Each request on its own thread: a long `exec` never
                        // holds up a `ping`.
                        std::thread::spawn(move || {
                            let answer = protocol::handle(platform.as_ref(), &request);
                            let _ = port.write_all(answer.as_bytes());
                        });
                    }
                }
                Err(_) => break,
            }
        }
        // Reopen: first release every I/O still pending on this handle
        // (a hello write waiting for the host), so the handle really closes.
        port.cancel();
        *current.lock().unwrap_or_else(|e| e.into_inner()) = None;
        std::thread::sleep(Duration::from_secs(1));
    }
}

// ── What the protocol asks for ──────────────────────────────────────────────

pub struct WindowsPlatform {
    os: String,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        // "Microsoft Windows [version 10.0.26200.8655]" → "Windows 10.0.26200.8655"
        let ver = Command::new("cmd.exe")
            .args(["/c", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let number: String = ver
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|part| part.matches('.').count() >= 2)
            .next()
            .unwrap_or("")
            .to_string();
        WindowsPlatform { os: if number.is_empty() { "Windows".into() } else { format!("Windows {number}") } }
    }
}

fn sockaddr_text(ptr: *const windows_sys::Win32::Networking::WinSock::SOCKADDR) -> Option<(bool, String)> {
    if ptr.is_null() {
        return None;
    }
    unsafe {
        match (*ptr).sa_family {
            AF_INET => {
                let addr = &*(ptr as *const SOCKADDR_IN);
                let raw = addr.sin_addr.S_un.S_addr.to_ne_bytes();
                Some((true, std::net::Ipv4Addr::from(raw).to_string()))
            }
            AF_INET6 => {
                let addr = &*(ptr as *const SOCKADDR_IN6);
                Some((false, std::net::Ipv6Addr::from(addr.sin6_addr.u.Byte).to_string()))
            }
            _ => None,
        }
    }
}

impl Platform for WindowsPlatform {
    fn hostname(&self) -> String {
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }

    fn os(&self) -> String {
        self.os.clone()
    }

    fn network(&self) -> Result<Value, String> {
        let mut size: u32 = 32 * 1024;
        let mut buffer: Vec<u64> = Vec::new();
        for _ in 0..3 {
            buffer = vec![0u64; (size as usize).div_ceil(8)];
            let status = unsafe {
                GetAdaptersAddresses(AF_UNSPEC as u32, 0, std::ptr::null(), buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH, &mut size)
            };
            match status {
                0 => break,
                111 => continue, // ERROR_BUFFER_OVERFLOW: size was updated
                code => return Err(format!("GetAdaptersAddresses: {code}")),
            }
        }
        let mut out = Vec::new();
        let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        unsafe {
            while !adapter.is_null() {
                let a = &*adapter;
                // 24: software loopback; OperStatus 1: up.
                if a.IfType != 24 && a.OperStatus == 1 {
                    let mut ipv4 = Vec::new();
                    let mut ipv6 = Vec::new();
                    let mut unicast = a.FirstUnicastAddress;
                    while !unicast.is_null() {
                        if let Some((v4, text)) = sockaddr_text((*unicast).Address.lpSockaddr) {
                            if v4 { ipv4.push(text) } else { ipv6.push(text) }
                        }
                        unicast = (*unicast).Next;
                    }
                    let name = if a.FriendlyName.is_null() {
                        String::new()
                    } else {
                        let len = (0..).take_while(|&i| *a.FriendlyName.add(i) != 0).count();
                        String::from_utf16_lossy(std::slice::from_raw_parts(a.FriendlyName, len))
                    };
                    let mac = a.PhysicalAddress[..a.PhysicalAddressLength as usize]
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<Vec<_>>()
                        .join(":");
                    out.push(json!({ "name": name, "mac": mac, "ipv4": ipv4, "ipv6": ipv6 }));
                }
                adapter = a.Next;
            }
        }
        Ok(Value::Array(out))
    }

    fn exec(&self, path: &str, args: &[String], timeout_ms: u64) -> Result<ExecResult, String> {
        let mut child = Command::new(path)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("{path}: {e}"))?;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let out = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
            buf
        });
        let err = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
            buf
        });
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(status);
            }
            if Instant::now() >= deadline {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        Ok(ExecResult {
            exit_code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: out.join().unwrap_or_default(),
            stderr: err.join().unwrap_or_default(),
            timed_out,
        })
    }

    fn shutdown(&self, reboot: bool) -> Result<(), String> {
        Command::new("shutdown.exe")
            .args([if reboot { "/r" } else { "/s" }, "/t", "0", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

// ── The service ─────────────────────────────────────────────────────────────

define_windows_service!(ffi_service_main, service_main);

pub fn run_service() -> Result<(), String> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| e.to_string())
}

fn service_main(_arguments: Vec<OsString>) {
    let stop = Arc::new(AtomicBool::new(false));
    let current: Arc<Mutex<Option<Arc<Port>>>> = Arc::new(Mutex::new(None));
    let handler = {
        let (stop, current) = (stop.clone(), current.clone());
        move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                stop.store(true, Ordering::SeqCst);
                if let Some(port) = current.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    port.cancel();
                }
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let Ok(status) = service_control_handler::register(SERVICE_NAME, handler) else { return };
    let state = |current_state, controls| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state,
        controls_accepted: controls,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    let _ = status.set_service_status(state(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN));
    serve(&stop, &current);
    let _ = status.set_service_status(state(ServiceState::Stopped, ServiceControlAccept::empty()));
}

/// Foreground mode, for a test from a console.
pub fn run_console() {
    let stop = AtomicBool::new(false);
    let current = Mutex::new(None);
    println!("Agent Virtua {} : {PORT_PATH}", protocol::VERSION);
    serve(&stop, &current);
}

/// Copy the agent to Program Files and (re)install the service, started.
pub fn install() -> Result<(), String> {
    let source = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = std::path::PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into()))
        .join("AuxiNux")
        .join("Virtua Agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let target = dir.join("virtua-agent.exe");

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)
        .map_err(|e| format!("service manager: {e}"))?;
    if let Ok(existing) = manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS) {
        let _ = existing.stop();
        for _ in 0..50 {
            match existing.query_status() {
                Ok(s) if s.current_state == ServiceState::Stopped => break,
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        let _ = existing.delete();
        drop(existing);
        std::thread::sleep(Duration::from_millis(500));
    }
    if !same_file(&source, &target) {
        std::fs::copy(&source, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    }

    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: DISPLAY_NAME.into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: target,
        launch_arguments: vec!["run".into()],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
        .map_err(|e| format!("create service: {e}"))?;
    let _ = service.set_description("Lien entre Windows et AuxiNux Virtua Desktop (état, réseau, applications du mode Unifié, arrêt).");
    let restart = ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(5) };
    let _ = service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(3600)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![restart.clone(), restart.clone(), restart]),
    });
    service.start::<&str>(&[]).map_err(|e| format!("start: {e}"))?;
    Ok(())
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn uninstall() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).map_err(|e| e.to_string())?;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::DELETE)
        .map_err(|e| e.to_string())?;
    let _ = service.stop();
    service.delete().map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn _assert_ptr(_: *const c_void) {}
