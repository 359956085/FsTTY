#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    #[cfg(windows)]
    if arguments
        .get(1)
        .is_some_and(|arg| arg == "--check-webview-runtime")
    {
        if let Err(error) = fstty_lib::check_webview_runtime() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if arguments
        .get(1)
        .is_some_and(|arg| arg == "--local-terminal-host")
    {
        if fstty_lib::run_local_terminal_host(&arguments[2..]).is_err() {
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|argument| argument == "--mcp-stdio") {
        if let Err(error) = fstty_lib::run_mcp_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    fstty_lib::run();
}
