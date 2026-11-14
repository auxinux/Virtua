//! Agent Virtua — the Windows guest service of AuxiNux Virtua Desktop.
//!
//!   virtua-agent install    copy to Program Files, (re)install and start the service
//!   virtua-agent uninstall  stop and remove the service
//!   virtua-agent run        service entry point (used by the service manager)
//!   virtua-agent console    serve the port in the foreground (tests)

mod protocol;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    let result = match command.as_str() {
        "install" => windows::install().map(|_| println!("Agent Virtua {} installé et démarré.", protocol::VERSION)),
        "uninstall" => windows::uninstall().map(|_| println!("Agent Virtua retiré.")),
        "run" => windows::run_service(),
        "console" => {
            windows::run_console();
            Ok(())
        }
        "--version" | "version" => {
            println!("{}", protocol::VERSION);
            Ok(())
        }
        _ => {
            eprintln!("Usage : virtua-agent install | uninstall | run | console | version");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("Agent Virtua : {error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Agent Virtua runs on Windows (x64, ARM64).");
}
