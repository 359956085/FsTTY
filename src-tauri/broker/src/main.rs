#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [command] if command == "--service" => fstty_broker::service::dispatch(),
        [command] if command == "--install" => fstty_broker::windows::install(),
        [command] if command == "--repair" => fstty_broker::admin::repair(),
        [command] if command == "--prepare-upgrade" => fstty_broker::windows::prepare_upgrade(),
        [command] if command == "--resume-upgrade" => fstty_broker::windows::resume_upgrade(),
        [command] if command == "--restore-upgrade" => fstty_broker::windows::restore_upgrade(),
        [command] if command == "--stop" => fstty_broker::windows::stop(false),
        [command] if command == "--uninstall" => fstty_broker::windows::stop(true),
        [command] if command == "--recover-installation" => fstty_broker::installation::recover(),
        [command] if command == "--remove-desktop" => fstty_broker::installation::uninstall(),
        [command, caller] if command == "--desktop-candidates" => caller
            .parse::<u32>()
            .map_err(|_| "调用者无效".into())
            .and_then(fstty_broker::installation::export_candidates),
        [command, caller] if command == "--launch-desktop" => caller
            .parse::<u32>()
            .map_err(|_| "调用者无效".into())
            .and_then(fstty_broker::installation::launch_desktop),
        [command, directory, caller, mode]
            if command == "--deploy-desktop" && matches!(mode.as_str(), "install" | "update") =>
        {
            caller
                .parse::<u32>()
                .map_err(|_| "调用者无效".into())
                .and_then(|pid| {
                    fstty_broker::installation::deploy(
                        std::path::Path::new(directory),
                        pid,
                        mode == "update",
                    )
                })
        }
        [command, ticket] if command == "--manage" => fstty_broker::admin::manage(ticket),
        [command, ticket, flag, theme] if command == "--manage" && flag == "--theme" => {
            fstty_broker::admin::Theme::parse(theme)
                .and_then(|theme| fstty_broker::admin::manage_with_theme(ticket, theme))
        }
        [command, ticket] if command == "--update" => fstty_broker::update::install(ticket),
        _ => Err("请通过 FsTTY 或安装程序管理凭据服务".into()),
    };
    if let Err(error) = result {
        if args.first().is_some_and(|command| {
            matches!(
                command.as_str(),
                "--desktop-candidates"
                    | "--deploy-desktop"
                    | "--remove-desktop"
                    | "--recover-installation"
                    | "--launch-desktop"
            )
        }) {
            fstty_broker::installation::report_error(&error);
        }
        eprintln!("{error}");
        if args
            .first()
            .is_some_and(|a| a == "--manage" || a == "--update" || a == "--repair")
        {
            fstty_broker::admin::show_error(&error);
        }
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("凭据服务仅支持 Windows");
    std::process::exit(1);
}
