//! Host side of the Agent Virtua (Desktop_client/agent): one persistent
//! connection per VM to the agent's virtio-serial port, shared by everyone
//! (state probes, Unified mode, shutdown).
//!
//! QEMU serves the port as a loopback TCP chardev that accepts one client at
//! a time; with the QEMU guest agent, every caller connecting on its own was
//! what got Unified mode reset on macOS. Here a single reader thread owns the
//! connection; requests carry an id and wait for the matching reply.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

/// Guest-arch builds of the agent, made by Desktop_client/agent/build.sh.
pub const AGENT_X64: &[u8] = include_bytes!("../agent-bin/virtua-agent-x64.exe");
pub const AGENT_ARM64: &[u8] = include_bytes!("../agent-bin/virtua-agent-arm64.exe");

pub fn agent_binary(architecture: &str) -> &'static [u8] {
    if architecture == "arm64" { AGENT_ARM64 } else { AGENT_X64 }
}

/// Version of the embedded agent binaries (Desktop_client/agent/Cargo.toml).
pub const BUNDLED_VERSION: &str = "0.2.0";

/// virtio-serial port name the agent opens in Windows.
pub const PORT_NAME: &str = "org.auxinux.virtua.0";

struct Link {
    stop: AtomicBool,
    writer: Mutex<Option<TcpStream>>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    /// The agent's `hello` for the current connection: present = agent running.
    hello: Mutex<Option<Value>>,
}

fn links() -> &'static Mutex<HashMap<u16, Arc<Link>>> {
    static LINKS: OnceLock<Mutex<HashMap<u16, Arc<Link>>>> = OnceLock::new();
    LINKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    static ID: AtomicU64 = AtomicU64::new(1);
    ID.fetch_add(1, Ordering::Relaxed)
}

/// The link for this port, its thread started on first use.
fn link(port: u16) -> Arc<Link> {
    let mut map = links().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = map.get(&port) {
        return existing.clone();
    }
    let link = Arc::new(Link {
        stop: AtomicBool::new(false),
        writer: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        hello: Mutex::new(None),
    });
    map.insert(port, link.clone());
    let worker = link.clone();
    std::thread::spawn(move || run(port, worker));
    link
}

/// The VM stopped: drop its link (the thread ends at its next turn).
pub fn forget(port: u16) {
    if let Some(link) = links().lock().unwrap_or_else(|e| e.into_inner()).remove(&port) {
        link.stop.store(true, Ordering::SeqCst);
        if let Some(stream) = link.writer.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        fail_pending(&link, "VM arrêtée");
    }
}

fn fail_pending(link: &Link, why: &str) {
    for (_, waiter) in link.pending.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        let _ = waiter.send(Err(why.to_string()));
    }
}

fn send_line(link: &Link, line: &str) -> Result<(), String> {
    let mut writer = link.writer.lock().unwrap_or_else(|e| e.into_inner());
    let stream = writer.as_mut().ok_or("Agent Virtua non connecté")?;
    stream.write_all(line.as_bytes()).map_err(|e| format!("Agent Virtua : {e}"))
}

fn run(port: u16, link: Arc<Link>) {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    while !link.stop.load(Ordering::SeqCst) {
        let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
            std::thread::sleep(Duration::from_secs(1));
            continue;
        };
        let _ = stream.set_nodelay(true);
        let Ok(reader_stream) = stream.try_clone() else { continue };
        *link.writer.lock().unwrap_or_else(|e| e.into_inner()) = Some(stream);
        *link.hello.lock().unwrap_or_else(|e| e.into_inner()) = None;

        // The agent says hello when its port opens; ask anyway, in case it
        // was already running before this connection.
        let hello_id = next_id();
        let _ = send_line(&link, &format!("{}\n", json!({ "id": hello_id, "cmd": "hello" })));

        // Until the agent answers (Windows still booting), ask again every
        // few seconds: a request sent before the agent opened its port may
        // be lost.
        let _ = reader_stream.set_read_timeout(Some(Duration::from_secs(3)));
        let mut reader = BufReader::new(reader_stream);
        let mut line = String::new();
        let mut hello_id = hello_id;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    if link.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if link.hello.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
                        hello_id = next_id();
                        let _ = send_line(&link, &format!("{}\n", json!({ "id": hello_id, "cmd": "hello" })));
                    }
                    continue;
                }
                Err(_) => break,
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
            match message.get("event").and_then(Value::as_str) {
                Some("hello") => {
                    *link.hello.lock().unwrap_or_else(|e| e.into_inner()) = message.get("hello").cloned();
                    continue;
                }
                Some("clipboard") => {
                    if let Some(text) = message.get("text").and_then(Value::as_str) {
                        clipboard::from_guest(port, text);
                    }
                    continue;
                }
                Some(_) => continue,
                None => {}
            }
            let Some(id) = message.get("id").and_then(Value::as_u64) else { continue };
            if id == hello_id {
                if let Some(hello) = message.get("ok") {
                    *link.hello.lock().unwrap_or_else(|e| e.into_inner()) = Some(hello.clone());
                }
                continue;
            }
            let waiter = link.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            if let Some(waiter) = waiter {
                let result = match (message.get("ok"), message.get("error")) {
                    (Some(ok), _) => Ok(ok.clone()),
                    (None, Some(error)) => Err(format!("Agent Virtua : {}", error.as_str().unwrap_or("erreur"))),
                    _ => Err("Agent Virtua : réponse invalide".into()),
                };
                let _ = waiter.send(result);
            }
        }
        *link.writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *link.hello.lock().unwrap_or_else(|e| e.into_inner()) = None;
        fail_pending(&link, "Agent Virtua déconnecté");
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The agent's hello (version, os, arch…) when it is running in the guest.
/// Starts the link if needed, so a first call may say "not yet".
pub fn hello(port: u16) -> Option<Value> {
    link(port).hello.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn ready(port: u16) -> bool {
    hello(port).is_some()
}

/// One request, waiting at most `timeout` for its reply.
pub fn request(port: u16, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
    let link = link(port);
    if link.hello.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
        return Err("Agent Virtua absent ou pas encore démarré dans la VM".into());
    }
    let id = next_id();
    let (tx, rx) = channel();
    link.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
    let line = format!("{}\n", json!({ "id": id, "cmd": cmd, "args": args }));
    if let Err(error) = send_line(&link, &line) {
        link.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return Err(error);
    }
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            link.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            Err(format!("Agent Virtua : pas de réponse à « {cmd} »"))
        }
    }
}

/// First IPv4 of an up adapter, from the agent's `network` answer.
pub fn first_ipv4(network: &Value) -> Option<String> {
    network.as_array()?.iter().find_map(|adapter| {
        adapter.get("ipv4")?.as_array()?.iter().filter_map(Value::as_str).find(|ip| !ip.starts_with("127.") && !ip.starts_with("169.254.")).map(str::to_string)
    })
}

/// Run a program in the guest (as SYSTEM); stdout and stderr decoded.
pub fn exec(port: u16, path: &str, args: &[String], timeout: Duration) -> Result<(i64, Vec<u8>, Vec<u8>), String> {
    use base64::Engine;
    let reply = request(
        port,
        "exec",
        json!({ "path": path, "args": args, "timeoutMs": timeout.as_millis() as u64 }),
        timeout + Duration::from_secs(10),
    )?;
    if reply.get("timedOut").and_then(Value::as_bool) == Some(true) {
        return Err(format!("{path} : délai dépassé dans la VM"));
    }
    let decode = |key: &str| {
        reply
            .get(key)
            .and_then(Value::as_str)
            .map(|s| base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default())
            .unwrap_or_default()
    };
    Ok((reply.get("exitCode").and_then(Value::as_i64).unwrap_or(-1), decode("stdout"), decode("stderr")))
}

/// Shared clipboard, with the VM whose console is on screen only: the host
/// clipboard is not handed to VMs in the background, and a background VM
/// cannot set it.
pub mod clipboard {
    use super::*;

    static FOCUS: Mutex<Option<u16>> = Mutex::new(None);
    /// Last text either side put on the host clipboard.
    static LAST: Mutex<Option<String>> = Mutex::new(None);

    fn host() -> &'static Mutex<Option<arboard::Clipboard>> {
        // Kept alive: on Linux the owner must stay to serve what it set.
        static CLIPBOARD: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();
        CLIPBOARD.get_or_init(|| Mutex::new(arboard::Clipboard::new().ok()))
    }

    fn host_text() -> Option<String> {
        host().lock().unwrap_or_else(|e| e.into_inner()).as_mut()?.get_text().ok()
    }

    /// The console of this agent port is shown (None: no console).
    pub fn set_focus(port: Option<u16>) {
        *FOCUS.lock().unwrap_or_else(|e| e.into_inner()) = port;
        static WATCHER: OnceLock<()> = OnceLock::new();
        WATCHER.get_or_init(|| {
            std::thread::spawn(watch_host);
        });
        if let (Some(port), Some(text)) = (port, host_text()) {
            push(port, text);
        }
    }

    fn push(port: u16, text: String) {
        *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.clone());
        if ready(port) {
            let _ = request(port, "clipboard-set", json!({ "text": text }), Duration::from_secs(5));
        }
    }

    fn watch_host() {
        loop {
            std::thread::sleep(Duration::from_millis(700));
            let Some(port) = *FOCUS.lock().unwrap_or_else(|e| e.into_inner()) else { continue };
            let Some(text) = host_text() else { continue };
            let changed = LAST.lock().unwrap_or_else(|e| e.into_inner()).as_deref() != Some(text.as_str());
            if changed {
                push(port, text);
            }
        }
    }

    /// Text copied in Windows: onto this computer's clipboard.
    pub(super) fn from_guest(port: u16, text: &str) {
        if *FOCUS.lock().unwrap_or_else(|e| e.into_inner()) != Some(port) {
            return;
        }
        *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.to_string());
        if let Some(clipboard) = host().lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = clipboard.set_text(text.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A fake QEMU chardev with a fake agent behind it.
    fn fake_agent() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            writer.write_all(b"{\"event\":\"hello\",\"hello\":{\"agent\":\"virtua\",\"version\":\"0.1.0\"}}\n").unwrap();
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let request: Value = serde_json::from_str(&line).unwrap();
                let id = request["id"].as_u64().unwrap();
                let reply = match request["cmd"].as_str().unwrap() {
                    "hello" => json!({ "id": id, "ok": { "agent": "virtua", "version": "0.1.0" } }),
                    "network" => json!({ "id": id, "ok": [{ "name": "lo", "ipv4": ["127.0.0.1"] }, { "name": "Ethernet", "ipv4": ["10.0.2.15"] }] }),
                    "slow" => {
                        std::thread::sleep(Duration::from_millis(300));
                        json!({ "id": id, "ok": "slow" })
                    }
                    _ => json!({ "id": id, "error": "unknown command" }),
                };
                writer.write_all(format!("{reply}\n").as_bytes()).unwrap();
            }
        });
        port
    }

    fn wait_ready(port: u16) {
        for _ in 0..50 {
            if ready(port) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("agent never said hello");
    }

    #[test]
    fn the_bundled_version_matches_the_agent_sources() {
        let manifest = include_str!("../../agent/Cargo.toml");
        assert!(manifest.contains(&format!("version = \"{BUNDLED_VERSION}\"")), "bump BUNDLED_VERSION with agent/Cargo.toml");
    }

    #[test]
    fn many_callers_share_one_connection() {
        let port = fake_agent();
        wait_ready(port);
        // The fake accepts a single client, like QEMU: parallel callers all
        // get their own answer through it.
        let callers: Vec<_> = (0..8)
            .map(|i| std::thread::spawn(move || if i % 2 == 0 { request(port, "slow", json!({}), Duration::from_secs(5)) } else { request(port, "network", json!({}), Duration::from_secs(5)) }))
            .collect();
        for caller in callers {
            assert!(caller.join().unwrap().is_ok());
        }
        let network = request(port, "network", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(first_ipv4(&network).as_deref(), Some("10.0.2.15"));
        assert!(request(port, "nope", json!({}), Duration::from_secs(5)).unwrap_err().contains("unknown command"));
        forget(port);
    }

    #[test]
    fn no_agent_means_a_clear_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // QEMU accepts the connection even when nothing runs in the guest.
        std::thread::spawn(move || {
            let _held = listener.accept();
            std::thread::sleep(Duration::from_secs(3));
        });
        assert!(!ready(port));
        assert!(request(port, "ping", json!({}), Duration::from_millis(200)).unwrap_err().contains("absent"));
        forget(port);
    }
}

/// Against a real Windows guest running the Agent Virtua:
/// `VIRTUA_AGENT_PORT=6390 cargo test --lib agent::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn against_a_real_windows_guest() {
        let port: u16 = std::env::var("VIRTUA_AGENT_PORT").expect("VIRTUA_AGENT_PORT").parse().unwrap();
        for _ in 0..100 {
            if ready(port) { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        let hello = hello(port).expect("hello");
        println!("hello: {hello}");
        let network = request(port, "network", json!({}), Duration::from_secs(5)).unwrap();
        println!("ipv4: {:?}", first_ipv4(&network));
        assert!(first_ipv4(&network).is_some());
        let (code, out, _) = exec(port, r"C:\Windows\System32\cmd.exe", &["/c".into(), "echo agent-ok".into()], Duration::from_secs(30)).unwrap();
        assert_eq!((code, String::from_utf8_lossy(&out).trim()), (0, "agent-ok"));
        let text = "Presse-papiers Virtua ✓ é\nligne 2";
        request(port, "clipboard-set", json!({ "text": text }), Duration::from_secs(5)).unwrap();
        let back = request(port, "clipboard-get", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(back["text"], text);
        let shown = request(port, "display", json!({ "width": 1440, "height": 920 }), Duration::from_secs(10)).unwrap();
        println!("display: {shown}");
        assert_eq!(shown, json!({ "width": 1440, "height": 900 }));
        // Parallel callers on the one connection.
        let callers: Vec<_> = (0..10).map(|_| std::thread::spawn(move || request(port, "ping", json!({}), Duration::from_secs(5)).is_ok())).collect();
        assert!(callers.into_iter().all(|c| c.join().unwrap()));
        println!("all good");
    }
}
