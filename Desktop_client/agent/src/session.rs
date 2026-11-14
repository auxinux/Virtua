//! The user-session half of the Agent Virtua: clipboard and display.
//!
//! The service runs as SYSTEM in session 0, which sees neither the user's
//! clipboard nor their screen. It starts `virtua-agent.exe session` in the
//! active console session (again whenever it exits or the user changes) and
//! talks to it over a named pipe that only SYSTEM and interactive users may
//! open. Host requests for the session (`clipboard-set`, `clipboard-get`,
//! `display`, `display-modes`) are forwarded as-is; the helper's replies and
//! its `clipboard` events go back to the host unchanged.

use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, HWND,
    INVALID_HANDLE_VALUE, LPARAM, LRESULT, WAIT_TIMEOUT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    ChangeDisplaySettingsExW, EnumDisplaySettingsW, CDS_UPDATEREGISTRY, DEVMODEW, DM_PELSHEIGHT, DM_PELSWIDTH, ENUM_CURRENT_SETTINGS,
};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows_sys::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateProcessAsUserW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WNDCLASSW,
};

use crate::protocol::LineBuffer;
use crate::windows::{wide, Port};

const PIPE_NAME: &str = r"\\.\pipe\virtua-agent-session";
/// SYSTEM: full; interactive users: read/write. Nobody else.
const PIPE_SDDL: &str = "D:(A;;GA;;;SY)(A;;GRGW;;;IU)";
const CF_UNICODETEXT: u32 = 13;
const WM_CLIPBOARDUPDATE: u32 = 0x031D;
/// Commands the service hands to the session helper.
pub const SESSION_COMMANDS: &[&str] = &["clipboard-set", "clipboard-get", "display", "display-modes"];

// ── Service side ────────────────────────────────────────────────────────────

/// The service's link to the helper of the active session.
pub struct SessionHub {
    link: Mutex<Option<Arc<Port>>>,
}

impl SessionHub {
    pub fn new() -> Arc<SessionHub> {
        Arc::new(SessionHub { link: Mutex::new(None) })
    }

    /// Hand a host request line to the helper; its reply reaches the host
    /// through the pipe reader.
    pub fn forward(&self, line: &str) -> Result<(), String> {
        let link = self.link.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let port = link.ok_or("Aucune session utilisateur ouverte dans Windows")?;
        port.write_all(line.as_bytes()).map_err(|code| format!("session : erreur {code}"))
    }

    /// Pipe server + helper launcher, for the life of the service.
    pub fn start(self: &Arc<Self>, to_host: Arc<dyn Fn(String) + Send + Sync>, stop: Arc<AtomicBool>) {
        let hub = self.clone();
        let stop_pipe = stop.clone();
        std::thread::spawn(move || hub.pipe_server(to_host, stop_pipe));
        std::thread::spawn(move || keep_helper_running(stop));
    }

    fn pipe_server(&self, to_host: Arc<dyn Fn(String) + Send + Sync>, stop: Arc<AtomicBool>) {
        while !stop.load(Ordering::SeqCst) {
            let Some(pipe) = create_pipe() else {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            if !wait_for_client(pipe) {
                unsafe { CloseHandle(pipe) };
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            let port = Arc::new(Port::from_handle(pipe));
            *self.link.lock().unwrap_or_else(|e| e.into_inner()) = Some(port.clone());
            let mut lines = LineBuffer::default();
            let mut buffer = vec![0u8; 64 * 1024];
            while let Ok(n) = port.read(&mut buffer) {
                if n == 0 {
                    continue;
                }
                for line in lines.push(&buffer[..n]) {
                    if line.trim_start().starts_with('{') {
                        to_host(line);
                    }
                }
            }
            *self.link.lock().unwrap_or_else(|e| e.into_inner()) = None;
            unsafe { DisconnectNamedPipe(port.handle) };
            // Dropping the Port closes the pipe handle.
        }
    }
}

fn create_pipe() -> Option<HANDLE> {
    unsafe {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(PIPE_SDDL).as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut()) == 0 {
            return None;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let pipe = CreateNamedPipeW(
            wide(PIPE_NAME).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        );
        LocalFree(descriptor as _);
        (pipe != INVALID_HANDLE_VALUE).then_some(pipe)
    }
}

fn wait_for_client(pipe: HANDLE) -> bool {
    unsafe {
        let event = CreateEventW(null(), 1, 0, null());
        let mut overlapped: OVERLAPPED = std::mem::zeroed();
        overlapped.hEvent = event;
        let connected = if ConnectNamedPipe(pipe, &mut overlapped) != 0 {
            true
        } else {
            match GetLastError() {
                ERROR_PIPE_CONNECTED => true,
                ERROR_IO_PENDING => {
                    let mut done = 0u32;
                    GetOverlappedResult(pipe, &overlapped, &mut done, 1) != 0
                }
                _ => false,
            }
        };
        CloseHandle(event);
        connected
    }
}

/// Keep one helper in the active console session (none at the logon screen).
fn keep_helper_running(stop: Arc<AtomicBool>) {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut current: Option<(u32, HANDLE)> = None;
    while !stop.load(Ordering::SeqCst) {
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        let alive = current.is_some_and(|(id, process)| id == session && unsafe { WaitForSingleObject(process, 0) } == WAIT_TIMEOUT);
        if !alive {
            if let Some((_, process)) = current.take() {
                unsafe {
                    TerminateProcess(process, 0);
                    CloseHandle(process);
                }
            }
            if session != u32::MAX {
                current = launch_in_session(session, &exe).map(|process| (session, process));
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    if let Some((_, process)) = current {
        unsafe {
            TerminateProcess(process, 0);
            CloseHandle(process);
        }
    }
}

fn launch_in_session(session: u32, exe: &std::path::Path) -> Option<HANDLE> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if WTSQueryUserToken(session, &mut token) == 0 {
            return None; // nobody logged on yet
        }
        let mut environment: *mut core::ffi::c_void = null_mut();
        CreateEnvironmentBlock(&mut environment, token, 0);
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut desktop = wide(r"winsta0\default");
        startup.lpDesktop = desktop.as_mut_ptr();
        let mut command = wide(&format!("\"{}\" session", exe.display()));
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            token,
            null(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment,
            null(),
            &startup,
            &mut info,
        );
        if !environment.is_null() {
            DestroyEnvironmentBlock(environment);
        }
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        CloseHandle(info.hThread);
        Some(info.hProcess)
    }
}

// ── Helper side (`virtua-agent session`) ────────────────────────────────────

static PIPE: OnceLock<Arc<Port>> = OnceLock::new();
static WINDOW: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(null_mut());
/// Text we put on the clipboard ourselves: its change notification is not
/// sent back to the host.
static LAST_SET: Mutex<Option<String>> = Mutex::new(None);
/// Text last sent to the host.
static LAST_SENT: Mutex<Option<String>> = Mutex::new(None);

fn send(value: Value) {
    if let Some(pipe) = PIPE.get() {
        if pipe.write_all(format!("{value}\n").as_bytes()).is_err() {
            std::process::exit(0); // the service went away
        }
    }
}

pub fn run_helper() -> Result<(), String> {
    let pipe = loop {
        let handle = unsafe {
            CreateFileW(wide(PIPE_NAME).as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, null_mut())
        };
        if handle != INVALID_HANDLE_VALUE {
            break Arc::new(Port::from_handle(handle));
        }
        std::thread::sleep(Duration::from_secs(1));
    };
    let _ = PIPE.set(pipe.clone());

    // Message-only window: clipboard notifications and clipboard ownership.
    let hwnd = unsafe {
        let instance = GetModuleHandleW(null());
        let class = wide("VirtuaAgentSession");
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&window_class);
        let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, null_mut(), instance, null());
        if hwnd.is_null() {
            return Err("fenêtre de session impossible".into());
        }
        AddClipboardFormatListener(hwnd);
        hwnd
    };
    WINDOW.store(hwnd, Ordering::SeqCst);

    std::thread::spawn(move || {
        let mut lines = LineBuffer::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => continue,
                Ok(n) => {
                    for line in lines.push(&buffer[..n]) {
                        if let Ok(request) = serde_json::from_str::<Value>(line.trim()) {
                            std::thread::spawn(move || answer(request));
                        }
                    }
                }
                Err(_) => std::process::exit(0),
            }
        }
    });

    unsafe {
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_CLIPBOARDUPDATE {
        if let Some(text) = clipboard_text(hwnd) {
            let echo = LAST_SET.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(text.as_str());
            // One copy often notifies several times (one per format).
            let mut sent = LAST_SENT.lock().unwrap_or_else(|e| e.into_inner());
            if !echo && sent.as_deref() != Some(text.as_str()) {
                *sent = Some(text.clone());
                send(json!({ "event": "clipboard", "text": text }));
            }
        }
        return 0;
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

fn answer(request: Value) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let args = request.get("args").cloned().unwrap_or(Value::Null);
    let hwnd = WINDOW.load(Ordering::SeqCst);
    let result: Result<Value, String> = match request.get("cmd").and_then(Value::as_str).unwrap_or("") {
        "clipboard-set" => {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            *LAST_SET.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.clone());
            set_clipboard_text(hwnd, &text).map(|_| json!({}))
        }
        "clipboard-get" => Ok(json!({ "text": unsafe { clipboard_text(hwnd) } })),
        "display-modes" => Ok(json!(display_modes().iter().map(|(w, h)| json!([w, h])).collect::<Vec<_>>())),
        "display" => {
            let width = args.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
            let height = args.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
            set_display(width, height).map(|(w, h)| json!({ "width": w, "height": h }))
        }
        other => Err(format!("unknown command: {other}")),
    };
    send(match result {
        Ok(ok) => json!({ "id": id, "ok": ok }),
        Err(error) => json!({ "id": id, "error": error }),
    });
}

fn open_clipboard(hwnd: HWND) -> bool {
    // Another program may hold it for a moment.
    for _ in 0..20 {
        if unsafe { OpenClipboard(hwnd) } != 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

unsafe fn clipboard_text(hwnd: HWND) -> Option<String> {
    if !open_clipboard(hwnd) {
        return None;
    }
    let data = GetClipboardData(CF_UNICODETEXT);
    let text = if data.is_null() {
        None
    } else {
        let pointer = GlobalLock(data as _) as *const u16;
        if pointer.is_null() {
            None
        } else {
            let len = (0..).take_while(|&i| *pointer.add(i) != 0).count();
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, len));
            GlobalUnlock(data as _);
            Some(text)
        }
    };
    CloseClipboard();
    text
}

fn set_clipboard_text(hwnd: HWND, text: &str) -> Result<(), String> {
    if !open_clipboard(hwnd) {
        return Err("presse-papiers occupé".into());
    }
    unsafe {
        EmptyClipboard();
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
        let ok = if memory.is_null() {
            false
        } else {
            let pointer = GlobalLock(memory) as *mut u16;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            GlobalUnlock(memory);
            !SetClipboardData(CF_UNICODETEXT, memory as _).is_null()
        };
        CloseClipboard();
        if ok { Ok(()) } else { Err("presse-papiers refusé".into()) }
    }
}

fn display_modes() -> Vec<(u32, u32)> {
    let mut modes = Vec::new();
    unsafe {
        let mut index = 0;
        loop {
            let mut mode: DEVMODEW = std::mem::zeroed();
            mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            if EnumDisplaySettingsW(null(), index, &mut mode) == 0 {
                break;
            }
            if mode.dmBitsPerPel >= 24 {
                modes.push((mode.dmPelsWidth, mode.dmPelsHeight));
            }
            index += 1;
        }
    }
    modes.sort();
    modes.dedup();
    modes
}

fn set_display(width: u32, height: u32) -> Result<(u32, u32), String> {
    let (w, h) = crate::protocol::pick_mode(&display_modes(), width.max(640), height.max(480)).ok_or("aucun mode d'affichage")?;
    unsafe {
        let mut mode: DEVMODEW = std::mem::zeroed();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        EnumDisplaySettingsW(null(), ENUM_CURRENT_SETTINGS, &mut mode);
        if mode.dmPelsWidth == w && mode.dmPelsHeight == h {
            return Ok((w, h));
        }
        mode.dmPelsWidth = w;
        mode.dmPelsHeight = h;
        mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
        let status = ChangeDisplaySettingsExW(null(), &mode, null_mut(), CDS_UPDATEREGISTRY, null());
        if status == 0 { Ok((w, h)) } else { Err(format!("changement de résolution refusé ({status})")) }
    }
}
