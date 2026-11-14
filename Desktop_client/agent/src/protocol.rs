//! Agent Virtua wire protocol — JSON lines over the virtio-serial port
//! `org.auxinux.virtua.0`.
//!
//! Host → guest: `{"id": 7, "cmd": "ping", "args": {…}}`
//! Guest → host: `{"id": 7, "ok": …}` or `{"id": 7, "error": "…"}`,
//! plus unsolicited `{"event": "hello", …}` when the port (re)opens.
//!
//! Lines that are not JSON requests are ignored: the channel may carry the
//! tail of an earlier session.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Commands understood by this agent (also announced in `hello`).
pub const COMMANDS: &[&str] = &["hello", "ping", "network", "exec", "shutdown", "clipboard-set", "clipboard-get", "display", "display-modes"];

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub cmd: String,
    #[serde(default)]
    pub args: Value,
}

/// What the guest can do; the Windows service implements it for real.
pub trait Platform {
    fn hostname(&self) -> String;
    fn os(&self) -> String;
    fn network(&self) -> Result<Value, String>;
    /// Run a program, capture its output, kill it after `timeout_ms`.
    fn exec(&self, path: &str, args: &[String], timeout_ms: u64) -> Result<ExecResult, String>;
    fn shutdown(&self, reboot: bool) -> Result<(), String>;
}

pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

pub fn hello(platform: &dyn Platform) -> Value {
    json!({
        "agent": "virtua",
        "version": VERSION,
        "arch": std::env::consts::ARCH,
        "hostname": platform.hostname(),
        "os": platform.os(),
        "commands": COMMANDS,
    })
}

pub fn parse(line: &str) -> Option<Request> {
    let line = line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0');
    if !line.starts_with('{') {
        return None;
    }
    serde_json::from_str(line).ok()
}

fn reply(id: u64, result: Result<Value, String>) -> String {
    let value = match result {
        Ok(ok) => json!({ "id": id, "ok": ok }),
        Err(error) => json!({ "id": id, "error": error }),
    };
    format!("{value}\n")
}

/// Handle one request; returns the reply line (with its `\n`).
pub fn handle(platform: &dyn Platform, request: &Request) -> String {
    let result = match request.cmd.as_str() {
        "hello" => Ok(hello(platform)),
        "ping" => Ok(json!({})),
        "network" => platform.network(),
        "exec" => exec(platform, &request.args),
        "shutdown" => {
            let reboot = request.args.get("reboot").and_then(Value::as_bool).unwrap_or(false);
            platform.shutdown(reboot).map(|_| json!({}))
        }
        other => Err(format!("unknown command: {other}")),
    };
    reply(request.id, result)
}

fn exec(platform: &dyn Platform, args: &Value) -> Result<Value, String> {
    let path = args.get("path").and_then(Value::as_str).ok_or("exec: path missing")?;
    let argv: Vec<String> = args
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let timeout_ms = args.get("timeoutMs").and_then(Value::as_u64).unwrap_or(120_000).clamp(1_000, 3_600_000);
    let result = platform.exec(path, &argv, timeout_ms)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(json!({
        "exitCode": result.exit_code,
        "stdout": b64.encode(&result.stdout),
        "stderr": b64.encode(&result.stderr),
        "timedOut": result.timed_out,
    }))
}

/// The largest display mode that fits `width`×`height` (the console's
/// size); the smallest one when none fits.
pub fn pick_mode(modes: &[(u32, u32)], width: u32, height: u32) -> Option<(u32, u32)> {
    modes
        .iter()
        .copied()
        .filter(|&(w, h)| w <= width && h <= height)
        .max_by_key(|&(w, h)| (w as u64) * (h as u64))
        .or_else(|| modes.iter().copied().min_by_key(|&(w, h)| (w as u64) * (h as u64)))
}

/// Splits a byte stream into lines; keeps a partial line for later.
#[derive(Default)]
pub struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        // A runaway line without newline (garbage) must not grow forever.
        if self.pending.len() > 16 * 1024 * 1024 {
            self.pending.clear();
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake;
    impl Platform for Fake {
        fn hostname(&self) -> String { "WIN11".into() }
        fn os(&self) -> String { "Windows 10.0.26200".into() }
        fn network(&self) -> Result<Value, String> { Ok(json!([{"name": "Ethernet", "ipv4": ["10.0.2.15"]}])) }
        fn exec(&self, path: &str, args: &[String], _t: u64) -> Result<ExecResult, String> {
            Ok(ExecResult { exit_code: 0, stdout: format!("{path} {}", args.join(" ")).into_bytes(), stderr: vec![], timed_out: false })
        }
        fn shutdown(&self, _reboot: bool) -> Result<(), String> { Ok(()) }
    }

    fn answer(line: &str) -> Value {
        serde_json::from_str(&handle(&Fake, &parse(line).unwrap())).unwrap()
    }

    #[test]
    fn requests_get_replies_with_their_id() {
        assert_eq!(answer(r#"{"id":1,"cmd":"ping"}"#), json!({"id":1,"ok":{}}));
        let hello = answer(r#"{"id":2,"cmd":"hello"}"#);
        assert_eq!(hello["ok"]["agent"], "virtua");
        assert_eq!(hello["ok"]["hostname"], "WIN11");
        assert!(hello["ok"]["commands"].as_array().unwrap().contains(&json!("exec")));
        assert_eq!(answer(r#"{"id":3,"cmd":"nope"}"#)["error"], "unknown command: nope");
    }

    #[test]
    fn exec_returns_base64_output() {
        let out = answer(r#"{"id":4,"cmd":"exec","args":{"path":"powershell.exe","args":["-NoProfile"]}}"#);
        let stdout = base64::engine::general_purpose::STANDARD.decode(out["ok"]["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(String::from_utf8(stdout).unwrap(), "powershell.exe -NoProfile");
        assert_eq!(out["ok"]["exitCode"], 0);
        assert!(answer(r#"{"id":5,"cmd":"exec","args":{}}"#)["error"].as_str().unwrap().contains("path"));
    }

    #[test]
    fn the_display_takes_the_largest_mode_that_fits_the_console() {
        let modes = [(800, 600), (1024, 768), (1280, 720), (1280, 800), (1920, 1080)];
        assert_eq!(pick_mode(&modes, 1366, 820), Some((1280, 800)));
        assert_eq!(pick_mode(&modes, 1920, 1200), Some((1920, 1080)));
        assert_eq!(pick_mode(&modes, 1100, 700), Some((800, 600)));
        assert_eq!(pick_mode(&modes, 300, 200), Some((800, 600)), "nothing fits: the smallest");
        assert_eq!(pick_mode(&[], 800, 600), None);
    }

    #[test]
    fn garbage_is_ignored_and_lines_are_reassembled() {
        assert!(parse("garbage").is_none());
        assert!(parse("\u{0}\u{0}{\"id\":1,\"cmd\":\"ping\"}").is_some());
        let mut buf = LineBuffer::default();
        assert!(buf.push(b"{\"id\":1,\"cm").is_empty());
        let lines = buf.push(b"d\":\"ping\"}\n{\"id\":2");
        assert_eq!(lines.len(), 1);
        assert_eq!(parse(&lines[0]).unwrap().id, 1);
    }
}
