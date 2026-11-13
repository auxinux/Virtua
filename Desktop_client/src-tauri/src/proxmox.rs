//! Proxmox VE mode: Virtua Desktop talks straight to a Proxmox VE server
//! (9.x API on port 8006) — no Virtua server in between.
//!
//! Everything goes through Rust:
//! - Proxmox ships a self-signed certificate. Rather than switching
//!   verification off, the certificate is *pinned*: the first connection shows
//!   its SHA-256 fingerprint (the one in Proxmox → System → Certificates), the
//!   user confirms it, and every request and console then requires exactly that
//!   certificate. A changed certificate is refused with its new fingerprint.
//! - Credentials stay here: the API ticket (renewed before its two hours run
//!   out) or the API token, kept in the system keyring when asked to.
//! - The webview cannot put Proxmox's auth cookie on a WebSocket. Consoles go
//!   through a loopback relay (like local mode's) that opens the authenticated
//!   `vncwebsocket` upstream; for a container shell it also translates
//!   termproxy's framing to the JSON protocol of the text console.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_PORT: u16 = 8006;
/// Tickets live two hours; renew well before.
const TICKET_RENEW_AFTER: Duration = Duration::from_secs(75 * 60);
const TOKEN_ACCOUNT: &str = "proxmox-api-token";
/// Prefix of the error raised when the server's certificate is not the pinned
/// one; the new fingerprint follows, for the UI to show.
pub const CERT_CHANGED: &str = "PVE_CERT_CHANGED:";

// ── Certificate pinning ─────────────────────────────────────────────────────

pub fn cert_fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn hex_only(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_uppercase()
}

pub fn same_fingerprint(a: &str, b: &str) -> bool {
    let (a, b) = (hex_only(a), hex_only(b));
    a.len() == 64 && a == b
}

#[derive(Debug)]
struct PinnedCert {
    /// None only for the probe, which reports what it saw.
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = cert_fingerprint(end_entity.as_ref());
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fingerprint.clone());
        }
        match &self.expected {
            None => Ok(ServerCertVerified::assertion()),
            Some(expected) if same_fingerprint(expected, &fingerprint) => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::General(format!("{CERT_CHANGED}{fingerprint}"))),
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn tls_config(expected: Option<String>, seen: Arc<Mutex<Option<String>>>) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = PinnedCert { expected, seen, provider: provider.clone() };
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

fn http_client(tls: rustls::ClientConfig) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// The readable reason of a transport error, keeping the pinning verdict.
fn transport_error(error: reqwest::Error, base: &str) -> String {
    let mut text = error.to_string();
    let mut source: Option<&dyn std::error::Error> = std::error::Error::source(&error);
    while let Some(inner) = source {
        text.push_str(" / ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    if let Some(at) = text.find(CERT_CHANGED) {
        let fingerprint: String = text[at + CERT_CHANGED.len()..].chars().take(95).collect();
        return format!("{CERT_CHANGED}{fingerprint}");
    }
    if error.is_timeout() {
        return format!("{base} ne répond pas (délai dépassé).");
    }
    if error.is_connect() {
        return format!("Connexion impossible à {base} : vérifiez l'adresse, le port (8006) et le pare-feu.");
    }
    text
}

// ── Addresses ───────────────────────────────────────────────────────────────

/// `pve.lan`, `10.0.0.5:8006`, `https://pve.lan:8006/#v1:…` → `https://host:port`.
pub fn normalize_base(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Adresse du serveur Proxmox manquante.".into());
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| format!("Adresse invalide : {trimmed}"))?;
    if url.scheme() != "https" {
        return Err("Proxmox VE se joint en https:// (port 8006).".into());
    }
    let host = url.host_str().ok_or_else(|| format!("Adresse invalide : {trimmed}"))?;
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() };
    // The URL parser drops an explicit :443 (https' default): look for it.
    let authority = with_scheme.split("://").nth(1).unwrap_or("").split(['/', '#', '?']).next().unwrap_or("");
    let port = url.port().unwrap_or(if authority.ends_with(":443") { 443 } else { DEFAULT_PORT });
    Ok(format!("https://{}:{}", host, port))
}

/// API paths come from the UI: keep them to the API's own alphabet.
pub fn validate_api_path(path: &str) -> Result<(), String> {
    let ok = path.starts_with('/')
        && !path.contains("..")
        && !path.contains("//")
        && path.len() < 512
        && path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.:@!".contains(c));
    if ok { Ok(()) } else { Err(format!("Chemin d'API refusé : {path}")) }
}

/// Form/query values: Proxmox wants booleans as 0/1.
pub fn api_params(params: Option<Value>) -> Result<Vec<(String, String)>, String> {
    let Some(params) = params else { return Ok(Vec::new()) };
    let Value::Object(map) = params else { return Err("Paramètres d'API : objet attendu.".into()) };
    let mut out = Vec::new();
    for (key, value) in map {
        let text = match value {
            Value::Null => continue,
            Value::Bool(b) => if b { "1".into() } else { "0".into() },
            Value::Number(n) => n.to_string(),
            Value::String(s) => s,
            other => other.to_string(),
        };
        out.push((key, text));
    }
    Ok(out)
}

// ── Session ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
enum Auth {
    Ticket { ticket: String, csrf: String, issued: Instant },
    Token(String),
}

#[derive(Clone)]
struct Session {
    base: String,
    fingerprint: String,
    username: String,
    auth: Auth,
    client: reqwest::Client,
    tls: Arc<rustls::ClientConfig>,
}

fn session_slot() -> &'static Mutex<Option<Session>> {
    static SLOT: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn current_session() -> Result<Session, String> {
    session_slot()
        .lock()
        .map_err(|_| "Session Proxmox indisponible.".to_string())?
        .clone()
        .ok_or_else(|| "Pas de connexion Proxmox : reconnectez-vous.".to_string())
}

fn store_session(session: Option<Session>) {
    if let Ok(mut slot) = session_slot().lock() {
        *slot = session;
    }
}

/// Client and TLS config that accept only the certificate with this fingerprint.
fn pinned(fingerprint: &str) -> Result<(reqwest::Client, Arc<rustls::ClientConfig>), String> {
    if !same_fingerprint(fingerprint, fingerprint) {
        return Err("Empreinte du certificat invalide (SHA-256 attendu).".into());
    }
    let tls = tls_config(Some(fingerprint.to_string()), Arc::new(Mutex::new(None)))?;
    Ok((http_client(tls.clone())?, Arc::new(tls)))
}

/// `{"data": …}`, or the server's reason when the call failed.
async fn read_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(json.get("data").cloned().unwrap_or(Value::Null));
    }
    let mut message = json.get("message").and_then(Value::as_str).map(|m| m.trim().to_string()).unwrap_or_default();
    if let Some(errors) = json.get("errors").and_then(Value::as_object) {
        let details: Vec<String> = errors.iter().map(|(k, v)| format!("{k} : {}", v.as_str().unwrap_or(&v.to_string()).trim())).collect();
        if !details.is_empty() {
            if !message.is_empty() { message.push_str(" — "); }
            message.push_str(&details.join(" ; "));
        }
    }
    if message.is_empty() {
        message = body.trim().chars().take(300).collect();
    }
    Err(match status.as_u16() {
        401 => "Proxmox a refusé l'authentification (identifiant, domaine ou mot de passe).".to_string(),
        403 => format!("Permission refusée par Proxmox{}", if message.is_empty() { String::new() } else { format!(" : {message}") }),
        code => format!("Proxmox ({code}) : {}", if message.is_empty() { status.canonical_reason().unwrap_or("erreur").to_string() } else { message }),
    })
}

async fn request(session: &Session, method: &str, path: &str, params: Vec<(String, String)>) -> Result<Value, String> {
    let url = format!("{}/api2/json{}", session.base, path);
    let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes()).map_err(|_| "Méthode HTTP invalide".to_string())?;
    let mut builder = session.client.request(method.clone(), &url);
    builder = match &session.auth {
        Auth::Ticket { ticket, csrf, .. } => {
            let b = builder.header("Cookie", format!("PVEAuthCookie={ticket}"));
            if method == reqwest::Method::GET { b } else { b.header("CSRFPreventionToken", csrf) }
        }
        Auth::Token(header) => builder.header("Authorization", header),
    };
    builder = if method == reqwest::Method::GET || method == reqwest::Method::DELETE {
        builder.query(&params)
    } else {
        builder.form(&params)
    };
    let response = builder.send().await.map_err(|e| transport_error(e, &session.base))?;
    read_response(response).await
}

async fn ticket_login(client: &reqwest::Client, base: &str, username: &str, password: &str) -> Result<(String, String, String), String> {
    let response = client
        .post(format!("{base}/api2/json/access/ticket"))
        .form(&[("username", username), ("password", password)])
        .send()
        .await
        .map_err(|e| transport_error(e, base))?;
    let data = read_response(response).await?;
    if data.get("NeedTFA").and_then(Value::as_i64).unwrap_or(0) != 0 || data.get("ticket").and_then(Value::as_str).is_some_and(|t| t.contains("!tfa!")) {
        return Err("Ce compte a la double authentification : utilisez plutôt un jeton d'API (Datacenter → Permissions → API Tokens).".into());
    }
    let ticket = data.get("ticket").and_then(Value::as_str).ok_or("Réponse de connexion Proxmox inattendue.")?.to_string();
    let csrf = data.get("CSRFPreventionToken").and_then(Value::as_str).unwrap_or_default().to_string();
    let user = data.get("username").and_then(Value::as_str).unwrap_or(username).to_string();
    Ok((ticket, csrf, user))
}

/// Renew a ticket before it expires (Proxmox accepts the ticket as password).
async fn fresh_session() -> Result<Session, String> {
    let mut session = current_session()?;
    if let Auth::Ticket { ticket, issued, .. } = &session.auth {
        if issued.elapsed() > TICKET_RENEW_AFTER {
            let (ticket, csrf, _) = ticket_login(&session.client, &session.base, &session.username, ticket).await?;
            session.auth = Auth::Ticket { ticket, csrf, issued: Instant::now() };
            store_session(Some(session.clone()));
        }
    }
    Ok(session)
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(crate::KEYCHAIN_SERVICE, TOKEN_ACCOUNT).map_err(|e| e.to_string())
}

fn token_header(username: &str, token_id: &str, secret: &str) -> Result<String, String> {
    let token_id = token_id.trim();
    if username.trim().is_empty() || token_id.is_empty() || secret.trim().is_empty() {
        return Err("Jeton d'API incomplet : utilisateur@domaine, nom du jeton et secret.".into());
    }
    // A pasted "user@realm!name" works too.
    let full = if token_id.contains('!') { token_id.to_string() } else { format!("{}!{}", username.trim(), token_id) };
    Ok(format!("PVEAPIToken={}={}", full, secret.trim()))
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    base: String,
    fingerprint: String,
}

/// Reach the server and report its certificate fingerprint, before trusting it.
#[tauri::command]
pub async fn pve_probe(url: String) -> Result<ProbeInfo, String> {
    let base = normalize_base(&url)?;
    let seen = Arc::new(Mutex::new(None));
    let client = http_client(tls_config(None, seen.clone())?)?;
    // Any HTTP answer will do: the handshake is what we want.
    let _ = client.get(format!("{base}/api2/json/version")).send().await.map_err(|e| transport_error(e, &base))?;
    let fingerprint = seen.lock().ok().and_then(|s| s.clone()).ok_or("Certificat du serveur illisible.")?;
    Ok(ProbeInfo { base, fingerprint })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    url: String,
    fingerprint: String,
    /// user@realm (root@pam, alice@pve…)
    username: String,
    password: Option<String>,
    token_id: Option<String>,
    token_secret: Option<String>,
    #[serde(default)]
    remember: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    base: String,
    fingerprint: String,
    username: String,
    auth: String,
    version: String,
    release: String,
}

async fn finish_login(session: Session) -> Result<SessionInfo, String> {
    let version = request(&session, "GET", "/version", Vec::new()).await?;
    let info = SessionInfo {
        base: session.base.clone(),
        fingerprint: session.fingerprint.clone(),
        username: session.username.clone(),
        auth: match session.auth { Auth::Ticket { .. } => "ticket".into(), Auth::Token(_) => "token".into() },
        version: version.get("version").and_then(Value::as_str).unwrap_or("?").to_string(),
        release: version.get("release").and_then(Value::as_str).unwrap_or("").to_string(),
    };
    store_session(Some(session));
    Ok(info)
}

#[tauri::command]
pub async fn pve_login(input: LoginInput) -> Result<SessionInfo, String> {
    let base = normalize_base(&input.url)?;
    let (client, tls) = pinned(&input.fingerprint)?;
    let username = input.username.trim().to_string();
    if !username.contains('@') {
        return Err("Identifiant sous la forme utilisateur@domaine (root@pam, alice@pve…).".into());
    }
    let session = match (&input.token_id, &input.token_secret) {
        (Some(id), Some(secret)) if !id.trim().is_empty() => {
            let header = token_header(&username, id, secret)?;
            let session = Session { base, fingerprint: input.fingerprint.clone(), username: username.clone(), auth: Auth::Token(header), client, tls };
            let info = finish_login(session).await?;
            if input.remember {
                token_entry()?.set_password(secret.trim()).map_err(|e| format!("Trousseau indisponible : {e}"))?;
            }
            return Ok(info);
        }
        _ => {
            let password = input.password.as_deref().filter(|p| !p.is_empty()).ok_or("Mot de passe ou jeton d'API requis.")?;
            let (ticket, csrf, user) = ticket_login(&client, &base, &username, password).await?;
            Session { base, fingerprint: input.fingerprint.clone(), username: user, auth: Auth::Ticket { ticket, csrf, issued: Instant::now() }, client, tls }
        }
    };
    finish_login(session).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreInput {
    url: String,
    fingerprint: String,
    username: String,
    token_id: String,
}

/// Reconnect at start-up with the API token kept in the keyring.
#[tauri::command]
pub async fn pve_restore(input: RestoreInput) -> Result<Option<SessionInfo>, String> {
    let Ok(secret) = token_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())) else {
        return Ok(None);
    };
    let base = normalize_base(&input.url)?;
    let (client, tls) = pinned(&input.fingerprint)?;
    let header = token_header(&input.username, &input.token_id, &secret)?;
    let session = Session { base, fingerprint: input.fingerprint, username: input.username, auth: Auth::Token(header), client, tls };
    finish_login(session).await.map(Some)
}

#[tauri::command]
pub async fn pve_logout(forget: bool) -> Result<(), String> {
    store_session(None);
    if forget {
        if let Ok(entry) = token_entry() {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

/// Any `/api2/json` call: GET/DELETE take query parameters, POST/PUT a form.
#[tauri::command]
pub async fn pve_api(method: String, path: String, params: Option<Value>) -> Result<Value, String> {
    validate_api_path(&path)?;
    let session = fresh_session().await?;
    request(&session, &method, &path, api_params(params)?).await
}

// ── Consoles ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleInfo {
    url: String,
    /// VNC password (the vncticket) for noVNC.
    password: Option<String>,
}

fn validate_guest(node: &str, kind: &str, vmid: u32) -> Result<(), String> {
    if !matches!(kind, "qemu" | "lxc") || vmid < 100 || node.is_empty() || !node.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        return Err("Machine Proxmox invalide.".into());
    }
    Ok(())
}

/// Graphical console (VNC) of a VM or container, or a container's shell.
#[tauri::command]
pub async fn pve_console(node: String, kind: String, vmid: u32, mode: String) -> Result<ConsoleInfo, String> {
    validate_guest(&node, &kind, vmid)?;
    let session = fresh_session().await?;
    let term = mode == "text";
    let endpoint = if term { "termproxy" } else { "vncproxy" };
    let params = if term { Vec::new() } else { vec![("websocket".to_string(), "1".to_string())] };
    let data = request(&session, "POST", &format!("/nodes/{node}/{kind}/{vmid}/{endpoint}"), params).await?;
    let port = data.get("port").and_then(|p| p.as_u64().or_else(|| p.as_str().and_then(|s| s.parse().ok()))).ok_or("Proxmox n'a pas ouvert de console.")?;
    let ticket = data.get("ticket").and_then(Value::as_str).ok_or("Proxmox n'a pas ouvert de console.")?.to_string();
    let user = data.get("user").and_then(Value::as_str).unwrap_or(&session.username).to_string();

    let mut upstream = reqwest::Url::parse(&format!("{}/api2/json/nodes/{node}/{kind}/{vmid}/vncwebsocket", session.base.replacen("https://", "wss://", 1)))
        .map_err(|e| e.to_string())?;
    upstream.query_pairs_mut().append_pair("port", &port.to_string()).append_pair("vncticket", &ticket);

    let relay = if term {
        RelayMode::Term { login: format!("{user}:{ticket}\n") }
    } else {
        RelayMode::Vnc
    };
    let url = spawn_relay(session, upstream.to_string(), relay).await?;
    Ok(ConsoleInfo { url, password: if term { None } else { Some(ticket) } })
}

enum RelayMode {
    Vnc,
    Term { login: String },
}

async fn connect_upstream(
    session: &Session,
    url: &str,
) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert("Sec-WebSocket-Protocol", HeaderValue::from_static("binary"));
    let auth = match &session.auth {
        Auth::Ticket { ticket, .. } => ("Cookie", format!("PVEAuthCookie={ticket}")),
        Auth::Token(header) => ("Authorization", header.clone()),
    };
    headers.insert(auth.0, HeaderValue::from_str(&auth.1).map_err(|e| e.to_string())?);
    let connector = tokio_tungstenite::Connector::Rustls(session.tls.clone());
    let (stream, _) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector))
        .await
        .map_err(|e| format!("Console Proxmox injoignable : {e}"))?;
    Ok(stream)
}

/// Decode as much UTF-8 as is complete; keep a split character for later.
pub fn take_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    match std::str::from_utf8(carry) {
        Ok(text) => {
            let text = text.to_string();
            carry.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            let valid = error.valid_up_to();
            let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
            carry.drain(..valid);
            text
        }
        Err(_) => {
            let text = String::from_utf8_lossy(carry).into_owned();
            carry.clear();
            text
        }
    }
}

/// The text console's JSON → termproxy frames (`0:len:data`, `1:cols:rows:`).
pub fn term_frame(json: &str) -> Option<String> {
    let message: Value = serde_json::from_str(json).ok()?;
    match message.get("type")?.as_str()? {
        "input" => {
            let data = message.get("data")?.as_str()?;
            Some(format!("0:{}:{}", data.len(), data))
        }
        "resize" => {
            let cols = message.get("cols")?.as_u64()?;
            let rows = message.get("rows")?.as_u64()?;
            Some(format!("1:{cols}:{rows}:"))
        }
        _ => None,
    }
}

async fn spawn_relay(session: Session, upstream_url: String, mode: RelayMode) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = crate::random_token();
    let expected_path = format!("/{token}");
    let term_login = match &mode { RelayMode::Term { login } => Some(login.clone()), RelayMode::Vnc => None };

    tauri::async_runtime::spawn(async move {
        // The ticket behind the console is single-use: one viewer, accepted
        // within 45 s.
        let Ok(Ok((stream, _))) = tokio::time::timeout(Duration::from_secs(45), listener.accept()).await else { return };
        let callback = |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
            if req.uri().path() != expected_path {
                let denied = tokio_tungstenite::tungstenite::http::Response::builder().status(403).body(Some("Forbidden".to_string())).expect("403");
                return Err(denied);
            }
            crate::negotiate_binary_protocol(req, response)
        };
        let Ok(local) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
        let (mut local_tx, mut local_rx) = local.split();
        let upstream = match connect_upstream(&session, &upstream_url).await {
            Ok(upstream) => upstream,
            Err(error) => {
                if term_login.is_some() {
                    let _ = local_tx.send(Message::Text(serde_json::json!({"type": "output", "data": format!("\r\n{error}\r\n")}).to_string().into())).await;
                }
                let _ = local_tx.close().await;
                return;
            }
        };
        let (mut up_tx, mut up_rx) = upstream.split();

        match term_login {
            None => {
                let down = async {
                    while let Some(Ok(message)) = local_rx.next().await {
                        let forward = match message {
                            Message::Binary(_) | Message::Text(_) => message,
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        if up_tx.send(forward).await.is_err() { break; }
                    }
                };
                let up = async {
                    while let Some(Ok(message)) = up_rx.next().await {
                        let forward = match message {
                            Message::Binary(_) | Message::Text(_) => message,
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        if local_tx.send(forward).await.is_err() { break; }
                    }
                };
                tokio::select! { _ = down => {}, _ = up => {} }
            }
            Some(login) => {
                if up_tx.send(Message::Text(login.into())).await.is_err() { return; }
                let down = async {
                    let mut keepalive = tokio::time::interval(Duration::from_secs(30));
                    keepalive.tick().await;
                    loop {
                        tokio::select! {
                            message = local_rx.next() => {
                                let Some(Ok(message)) = message else { break };
                                let text = match message {
                                    Message::Text(text) => text.to_string(),
                                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                                    Message::Close(_) => break,
                                    _ => continue,
                                };
                                if let Some(frame) = term_frame(&text) {
                                    if up_tx.send(Message::Text(frame.into())).await.is_err() { break; }
                                }
                            }
                            _ = keepalive.tick() => {
                                if up_tx.send(Message::Text("2".into())).await.is_err() { break; }
                            }
                        }
                    }
                };
                let up = async {
                    let mut carry = Vec::new();
                    let mut greeted = false;
                    while let Some(Ok(message)) = up_rx.next().await {
                        let bytes: Vec<u8> = match message {
                            Message::Binary(bytes) => bytes.to_vec(),
                            Message::Text(text) => text.as_bytes().to_vec(),
                            Message::Close(_) => break,
                            _ => continue,
                        };
                        let mut slice = &bytes[..];
                        if !greeted {
                            // termproxy acknowledges the login with "OK".
                            greeted = true;
                            if slice.starts_with(b"OK") { slice = &slice[2..]; }
                        }
                        let text = take_utf8(&mut carry, slice);
                        if text.is_empty() { continue; }
                        let json = serde_json::json!({ "type": "output", "data": text }).to_string();
                        if local_tx.send(Message::Text(json.into())).await.is_err() { break; }
                    }
                };
                tokio::select! { _ = down => {}, _ = up => {} }
            }
        }
    });

    Ok(format!("ws://127.0.0.1:{port}/{token}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_default_to_https_on_8006() {
        assert_eq!(normalize_base("pve.lan").unwrap(), "https://pve.lan:8006");
        assert_eq!(normalize_base(" 10.0.0.5 ").unwrap(), "https://10.0.0.5:8006");
        assert_eq!(normalize_base("https://pve.lan:8006/#v1:0:18").unwrap(), "https://pve.lan:8006");
        assert_eq!(normalize_base("pve.lan:443").unwrap(), "https://pve.lan:443");
        assert!(normalize_base("http://pve.lan").is_err());
        assert!(normalize_base("").is_err());
    }

    #[test]
    fn fingerprints_compare_whatever_the_separators() {
        let fp = cert_fingerprint(b"certificate");
        assert_eq!(fp.len(), 95);
        assert!(same_fingerprint(&fp, &fp.replace(':', "").to_lowercase()));
        assert!(!same_fingerprint(&fp, &cert_fingerprint(b"other")));
        assert!(!same_fingerprint("AB:CD", "AB:CD"), "a truncated fingerprint never matches");
    }

    #[test]
    fn api_paths_stay_inside_the_api() {
        assert!(validate_api_path("/nodes/pve/qemu/100/status/start").is_ok());
        assert!(validate_api_path("/cluster/resources").is_ok());
        assert!(validate_api_path("/nodes/pve/storage/local:iso/content").is_ok());
        assert!(validate_api_path("nodes").is_err());
        assert!(validate_api_path("/nodes/../../etc").is_err());
        assert!(validate_api_path("/nodes?x=1").is_err());
        assert!(validate_api_path("https://evil/").is_err());
    }

    #[test]
    fn params_become_proxmox_form_values() {
        let params = api_params(Some(serde_json::json!({"start": true, "onboot": false, "cores": 2, "name": "web", "skip": null}))).unwrap();
        assert!(params.contains(&("start".into(), "1".into())));
        assert!(params.contains(&("onboot".into(), "0".into())));
        assert!(params.contains(&("cores".into(), "2".into())));
        assert!(params.contains(&("name".into(), "web".into())));
        assert_eq!(params.len(), 4);
        assert!(api_params(Some(serde_json::json!([1]))).is_err());
    }

    #[test]
    fn the_text_console_speaks_termproxy() {
        assert_eq!(term_frame(r#"{"type":"input","data":"ls\r"}"#).unwrap(), "0:3:ls\r");
        // Length in bytes, as termproxy counts it.
        assert_eq!(term_frame(r#"{"type":"input","data":"é"}"#).unwrap(), "0:2:é");
        assert_eq!(term_frame(r#"{"type":"resize","cols":120,"rows":40}"#).unwrap(), "1:120:40:");
        assert!(term_frame("garbage").is_none());
    }

    #[test]
    fn split_utf8_characters_wait_for_their_end() {
        let mut carry = Vec::new();
        let bytes = "é".as_bytes();
        assert_eq!(take_utf8(&mut carry, &bytes[..1]), "");
        assert_eq!(take_utf8(&mut carry, &bytes[1..]), "é");
        assert!(carry.is_empty());
    }

    #[test]
    fn api_tokens_accept_a_full_or_short_id() {
        assert_eq!(token_header("root@pam", "virtua", "s3cret").unwrap(), "PVEAPIToken=root@pam!virtua=s3cret");
        assert_eq!(token_header("root@pam", "alice@pve!desk", "x").unwrap(), "PVEAPIToken=alice@pve!desk=x");
        assert!(token_header("root@pam", "", "x").is_err());
    }
}

/// End-to-end against a real Proxmox VE server:
/// `PVE_URL=127.0.0.1:18006 PVE_USER=root@pam PVE_PASSWORD=… cargo test --lib proxmox::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} missing"))
    }

    async fn api(method: &str, path: &str, params: Value) -> Result<Value, String> {
        pve_api(method.into(), path.into(), if params.is_null() { None } else { Some(params) }).await
    }

    async fn wait_task(node: &str, upid: &Value) {
        let Some(upid) = upid.as_str() else { return };
        for _ in 0..600 {
            let status = api("GET", &format!("/nodes/{node}/tasks/{upid}/status"), Value::Null).await.unwrap();
            if status["status"] == "stopped" {
                let exit = status["exitstatus"].as_str().unwrap_or("");
                assert!(exit == "OK" || exit.starts_with("WARNINGS"), "task {upid} failed: {status}");
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!("task {upid} did not finish");
    }

    async fn first_ws_bytes(url: &str, send: Vec<String>, want: impl Fn(&str) -> bool) -> String {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("relay reachable");
        for message in send {
            ws.send(Message::Text(message.into())).await.unwrap();
        }
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while tokio::time::Instant::now() < deadline {
            let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await else { continue };
            match message {
                Message::Binary(b) => seen.push_str(&String::from_utf8_lossy(&b)),
                Message::Text(t) => seen.push_str(t.as_str()),
                _ => {}
            }
            if want(&seen) {
                break;
            }
        }
        seen
    }

    #[test]
    #[ignore]
    fn against_a_real_proxmox() {
        tauri::async_runtime::block_on(async {
            let url = env("PVE_URL");
            let probe = pve_probe(url.clone()).await.expect("probe");
            println!("fingerprint {}", probe.fingerprint);

            // A wrong pin is refused, with the real fingerprint for the UI.
            let wrong = "00:".repeat(31) + "00";
            let err = pve_login(LoginInput { url: url.clone(), fingerprint: wrong, username: env("PVE_USER"), password: Some(env("PVE_PASSWORD")), token_id: None, token_secret: None, remember: false })
                .await.err().expect("wrong pin must fail");
            assert!(err.starts_with(CERT_CHANGED) && same_fingerprint(&err[CERT_CHANGED.len()..], &probe.fingerprint), "{err}");

            let info = pve_login(LoginInput { url: url.clone(), fingerprint: probe.fingerprint.clone(), username: env("PVE_USER"), password: Some(env("PVE_PASSWORD")), token_id: None, token_secret: None, remember: false })
                .await.expect("login");
            println!("connected: Proxmox VE {} as {}", info.version, info.username);
            assert!(info.version.starts_with('9'), "{}", info.version);

            let nodes = api("GET", "/nodes", Value::Null).await.unwrap();
            let node = nodes[0]["node"].as_str().unwrap().to_string();

            // API token, as a user would make one.
            let _ = api("DELETE", "/access/users/root@pam/token/virtua-itest", Value::Null).await;
            let token = api("POST", "/access/users/root@pam/token/virtua-itest", serde_json::json!({"privsep": false})).await.unwrap();
            let secret = token["value"].as_str().unwrap().to_string();
            let as_token = pve_login(LoginInput { url: url.clone(), fingerprint: probe.fingerprint.clone(), username: "root@pam".into(), password: None, token_id: Some("virtua-itest".into()), token_secret: Some(secret), remember: false })
                .await.expect("token login");
            assert_eq!(as_token.auth, "token");

            // A VM (no OS: the firmware screen is enough for VNC).
            for vmid in [9001, 9002] {
                let _ = api("POST", &format!("/nodes/{node}/{}/{vmid}/status/stop", if vmid == 9001 { "qemu" } else { "lxc" }), Value::Null).await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                let _ = api("DELETE", &format!("/nodes/{node}/{}/{vmid}", if vmid == 9001 { "qemu" } else { "lxc" }), serde_json::json!({"purge": true})).await;
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
            let upid = api("POST", &format!("/nodes/{node}/qemu"), serde_json::json!({
                "vmid": 9001, "name": "virtua-itest", "memory": 256, "cores": 1, "scsi0": "local-lvm:1", "start": true,
            })).await.expect("create VM");
            wait_task(&node, &upid).await;
            let vnc = pve_console(node.clone(), "qemu".into(), 9001, "vnc".into()).await.expect("vnc console");
            assert!(vnc.password.is_some());
            let banner = first_ws_bytes(&vnc.url, Vec::new(), |s| s.contains("RFB")).await;
            println!("VM console says: {:?}", banner.chars().take(12).collect::<String>());
            assert!(banner.starts_with("RFB 003.008"), "{banner:?}");

            // A container from a downloaded template: its shell through termproxy.
            let available = api("GET", &format!("/nodes/{node}/aplinfo"), Value::Null).await.unwrap();
            let template = available.as_array().unwrap().iter()
                .filter_map(|t| t["template"].as_str())
                .find(|t| t.starts_with("debian-13-standard") || t.starts_with("debian-12-standard"))
                .expect("a debian template in aplinfo").to_string();
            let have = api("GET", &format!("/nodes/{node}/storage/local/content"), serde_json::json!({"content": "vztmpl"})).await.unwrap();
            if !have.as_array().unwrap().iter().any(|v| v["volid"].as_str().is_some_and(|v| v.ends_with(&template))) {
                let upid = api("POST", &format!("/nodes/{node}/aplinfo"), serde_json::json!({"storage": "local", "template": template})).await.expect("download template");
                wait_task(&node, &upid).await;
            }
            let upid = api("POST", &format!("/nodes/{node}/lxc"), serde_json::json!({
                "vmid": 9002, "hostname": "virtua-ct", "ostemplate": format!("local:vztmpl/{template}"),
                "rootfs": "local-lvm:2", "memory": 256, "password": "VirtuaTest1", "unprivileged": true, "start": true,
            })).await.expect("create CT");
            wait_task(&node, &upid).await;
            // `start` in the create call may still be in progress: wait for it.
            for _ in 0..60 {
                let st = api("GET", &format!("/nodes/{node}/lxc/9002/status/current"), Value::Null).await.unwrap();
                if st["status"] == "running" { break; }
                if st["status"] == "stopped" && st["lock"].is_null() {
                    let upid = api("POST", &format!("/nodes/{node}/lxc/9002/status/start"), Value::Null).await.unwrap();
                    wait_task(&node, &upid).await;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            tokio::time::sleep(Duration::from_secs(6)).await;
            let shell = pve_console(node.clone(), "lxc".into(), 9002, "text".into()).await.expect("term console");
            let output = first_ws_bytes(
                &shell.url,
                vec![r#"{"type":"resize","cols":100,"rows":30}"#.into(), r#"{"type":"input","data":"\r"}"#.into()],
                |s| s.contains("login"),
            ).await;
            println!("CT shell says: {:?}", output.chars().take(160).collect::<String>());
            assert!(output.contains(r#""type":"output""#) && output.contains("login"), "{output}");

            // Snapshot, config change, cleanup.
            let upid = api("POST", &format!("/nodes/{node}/lxc/9002/snapshot"), serde_json::json!({"snapname": "itest"})).await.expect("snapshot");
            wait_task(&node, &upid).await;
            api("PUT", &format!("/nodes/{node}/lxc/9002/config"), serde_json::json!({"cores": 2, "description": "Virtua itest"})).await.expect("config");
            let cfg = api("GET", &format!("/nodes/{node}/lxc/9002/config"), Value::Null).await.unwrap();
            assert_eq!(cfg["cores"], 2);
            for (kind, vmid) in [("qemu", 9001), ("lxc", 9002)] {
                let upid = api("POST", &format!("/nodes/{node}/{kind}/{vmid}/status/stop"), Value::Null).await.unwrap();
                wait_task(&node, &upid).await;
                let upid = api("DELETE", &format!("/nodes/{node}/{kind}/{vmid}"), serde_json::json!({"purge": true})).await.unwrap();
                wait_task(&node, &upid).await;
            }
            api("DELETE", "/access/users/root@pam/token/virtua-itest", Value::Null).await.unwrap();
            pve_logout(false).await.unwrap();
            println!("all good");
        });
    }
}
