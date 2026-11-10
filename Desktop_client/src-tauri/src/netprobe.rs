//! Why a Virtua server cannot be reached, in words the user can act on.
//!
//! The HTTP plugin only reports "error sending request for url (…)" for every
//! network failure — refused port, unreachable host, macOS refusing local
//! network access, HTTP sent to an HTTPS port… The probe tells them apart and
//! finds which scheme the port actually speaks, so the client can retry with
//! the right one.
use super::*;
use std::net::ToSocketAddrs;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// A TCP connection to host:port succeeded.
    pub reachable: bool,
    /// `http` or `https`, when the port answered one of them.
    pub speaks: Option<String>,
    /// What went wrong, in French, when it did.
    pub problem: Option<String>,
}

fn is_private(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }) || host.ends_with(".local")
}

/// The OS error of a failed connect, explained for this host.
pub fn explain_connect_error(error: &std::io::Error, host: &str, port: u16, os: &str) -> String {
    let unreachable = matches!(error.raw_os_error(), Some(65 | 51 | 113 | 101 | 1 | 13 | 10065 | 10051));
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => format!(
            "{host} répond mais le port {port} est fermé : l’API Virtua n’écoute pas (service arrêté après une mise à jour ? « systemctl status auxinuxvirtual-api » sur le nœud) ou le port n’est pas le bon."
        ),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => format!(
            "Aucune réponse de {host}:{port} : adresse incorrecte, machine éteinte, ou pare-feu qui bloque le port {port}."
        ),
        _ if unreachable && os == "macos" && is_private(host) => format!(
            "macOS bloque l’accès au réseau local : Réglages Système → Confidentialité et sécurité → Réseau local → autorisez « AuxiNux Virtua Desktop Client », puis réessayez. ({error})"
        ),
        _ if unreachable => format!("{host} est injoignable depuis cet ordinateur (pas de route vers ce réseau : VPN, Wi-Fi invité, câble ?). ({error})"),
        _ => format!("Connexion à {host}:{port} impossible : {error}"),
    }
}

fn speaks(scheme: &str, host: &str, port: u16) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(6))
        // Only asking "does this port speak TLS?": a self-signed node
        // certificate is the normal case on a LAN.
        .danger_accept_invalid_certs(true)
        .build()
    else {
        return false;
    };
    let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    client.get(format!("{scheme}://{host}:{port}/api/health")).send().is_ok()
}

pub fn probe(endpoint: &str) -> Probe {
    let Ok(url) = reqwest::Url::parse(endpoint.trim()) else {
        return Probe { reachable: false, speaks: None, problem: Some(format!("Adresse invalide : {endpoint}")) };
    };
    let Some(host) = url.host_str().map(|h| h.trim_matches(['[', ']']).to_string()) else {
        return Probe { reachable: false, speaks: None, problem: Some("Adresse sans nom d’hôte".into()) };
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<SocketAddr> = match (host.as_str(), port).to_socket_addrs() {
        Ok(found) => found.collect(),
        Err(error) => {
            return Probe { reachable: false, speaks: None, problem: Some(format!("Nom « {host} » introuvable (DNS) : {error}")) };
        }
    };
    let mut last_error = None;
    let mut connected = false;
    for address in &addresses {
        match TcpStream::connect_timeout(address, Duration::from_secs(4)) {
            Ok(_) => {
                connected = true;
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    if !connected {
        let problem = last_error
            .map(|e| explain_connect_error(&e, &host, port, env::consts::OS))
            .unwrap_or_else(|| format!("Aucune adresse pour {host}"));
        return Probe { reachable: false, speaks: None, problem: Some(problem) };
    }
    let wanted = url.scheme().to_string();
    let other = if wanted == "https" { "http" } else { "https" };
    if speaks(&wanted, &host, port) {
        return Probe { reachable: true, speaks: Some(wanted), problem: None };
    }
    if speaks(other, &host, port) {
        return Probe {
            reachable: true,
            speaks: Some(other.to_string()),
            problem: Some(format!("Le port {port} de {host} parle {}, pas {wanted}.", other.to_uppercase())),
        };
    }
    Probe {
        reachable: true,
        speaks: None,
        problem: Some(format!("{host}:{port} accepte la connexion mais ne répond ni en HTTP ni en HTTPS : ce n’est pas l’API Virtua (port 8441 pour un nœud, 8440 pour un VDM).")),
    }
}

#[tauri::command]
pub async fn desktop_probe_server(endpoint: String) -> Probe {
    tauri::async_runtime::spawn_blocking(move || probe(&endpoint))
        .await
        .unwrap_or(Probe { reachable: false, speaks: None, problem: Some("Diagnostic impossible".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_errors_are_explained() {
        let refused = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
        assert!(explain_connect_error(&refused, "192.168.0.20", 8441, "linux").contains("port 8441 est fermé"));
        // EHOSTUNREACH on macOS for a LAN address: the Local Network privacy switch.
        let no_route = std::io::Error::from_raw_os_error(65);
        assert!(explain_connect_error(&no_route, "192.168.0.20", 8441, "macos").contains("Réseau local"));
        assert!(!explain_connect_error(&no_route, "virtua.example.com", 8441, "macos").contains("Réseau local"));
        let timeout = std::io::Error::from(std::io::ErrorKind::TimedOut);
        assert!(explain_connect_error(&timeout, "10.0.0.2", 8441, "windows").contains("pare-feu"));
    }

    #[test]
    fn a_closed_port_is_reported_as_closed() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let probe = probe(&format!("http://127.0.0.1:{port}"));
        assert!(!probe.reachable);
        assert!(probe.problem.unwrap().contains("fermé"));
    }

    #[test]
    fn the_scheme_the_port_speaks_is_found() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // The TCP check, the failed TLS attempt, then the HTTP request.
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut buffer = [0u8; 1024];
                let n = socket.read(&mut buffer).unwrap_or(0);
                if n > 0 {
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                }
            }
        });
        // Asked in https, the port speaks plain HTTP: retry in http.
        let probe = probe(&format!("https://127.0.0.1:{port}"));
        assert!(probe.reachable);
        let _ = server.join();
        assert_eq!(probe.speaks.as_deref(), Some("http"));
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn probe_live() {
        let target = std::env::var("VIRTUA_PROBE").unwrap();
        println!("{:?}", super::probe(&target));
    }
}
