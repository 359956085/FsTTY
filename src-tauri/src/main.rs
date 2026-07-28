#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--mcp-stdio") {
        if let Err(error) = fstty_lib::run_mcp_stdio() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    fstty_lib::run();
}
