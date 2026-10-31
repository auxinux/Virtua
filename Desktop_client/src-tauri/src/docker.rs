//! Pin Docker operations to a verified local endpoint, regardless of context changes.
use super::*;
fn local_endpoint(value: &str) -> bool {
    value.starts_with("unix:///") || value.starts_with("npipe:////./pipe/")
}
/// `docker context inspect` costs a process spawn; the inventory refresh used
/// to pay it before every `docker ps`. Thirty seconds is short enough to see
/// a context switched in Docker Desktop on the next refreshes.
static ENDPOINT: std::sync::Mutex<Option<(std::time::Instant, String)>> = std::sync::Mutex::new(None);

pub fn endpoint() -> Result<String, String> {
    if let Some((at, host)) = ENDPOINT.lock().ok().and_then(|cache| cache.clone()) {
        if at.elapsed() < Duration::from_secs(30) {
            return Ok(host);
        }
    }
    let host = resolve_endpoint()?;
    if let Ok(mut cache) = ENDPOINT.lock() {
        *cache = Some((std::time::Instant::now(), host.clone()));
    }
    Ok(host)
}

fn resolve_endpoint() -> Result<String, String> {
    let context = env::var("DOCKER_CONTEXT").ok().filter(|s| !s.is_empty());
    if context.is_none() {
        if let Ok(host) = env::var("DOCKER_HOST") {
            if !host.is_empty() {
                return if local_endpoint(&host) {
                    Ok(host)
                } else {
                    Err("Le contexte Docker pointe vers un serveur distant. Sélectionnez votre moteur local dans Docker avant de continuer.".into())
                };
            }
        }
    }
    let mut cmd = platform::command("docker");
    cmd.args(["context", "inspect"]);
    if let Some(context) = context {
        cmd.arg(context);
    }
    cmd.args(["--format", "{{.Endpoints.docker.Host}}"]);
    let host = platform::output(cmd, Duration::from_secs(8))?;
    if local_endpoint(&host) {
        Ok(host)
    } else {
        Err("Le contexte Docker actif n’est pas local. Sélectionnez Docker Desktop ou votre socket Docker local.".into())
    }
}
pub fn command() -> Result<Command, String> {
    let host = endpoint()?;
    let mut cmd = platform::command("docker");
    for key in [
        "DOCKER_CONTEXT",
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
    ] {
        cmd.env_remove(key);
    }
    cmd.args(["--host", &host]);
    Ok(cmd)
}
pub fn probe(args: &[&str]) -> Result<String, String> {
    let mut cmd = command()?;
    cmd.args(args);
    platform::output(cmd, Duration::from_secs(8))
}
pub fn list() -> Vec<LocalContainerResource> {
    if find_binary("docker").is_none() {
        return vec![];
    }
    let Ok(raw) = probe(&["ps", "-a", "--format", "json"]) else {
        return vec![];
    };
    raw.lines()
        .filter_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            let name = value["Names"].as_str()?;
            Some(LocalContainerResource {
                id: format!("docker:{name}"),
                kind: "docker".into(),
                name: name.into(),
                image: value["Image"].as_str().map(str::to_string),
                state: normalize_container_state(value["State"].as_str().unwrap_or("stopped")),
                ip: None,
                ports: value["Ports"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                cpu_usage: None,
                memory_usage: None,
                uptime_seconds: None,
            })
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_remote_docker_endpoints_in_local_mode() {
        assert!(local_endpoint("unix:///var/run/docker.sock"));
        assert!(local_endpoint("npipe:////./pipe/docker_engine"));
        assert!(!local_endpoint("ssh://server"));
        assert!(!local_endpoint("tcp://server:2375"));
        assert!(!local_endpoint("npipe:////server/pipe/docker_engine"));
    }
}
