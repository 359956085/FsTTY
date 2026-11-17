use super::*;
use crate::services::SettingsService;
use russh::{server, ChannelId};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};

const FIXTURE: &str = "FSTTY_TEST_STDIO_DIRECTORY";

struct Directory(PathBuf);

impl Directory {
    fn enabled() -> Self {
        let path = std::env::temp_dir().join(Uuid::new_v4().to_string());
        fs::create_dir(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        SettingsService::load(&path)
            .update_mcp(true, false, 37653, vec![tests::mcp_permission(true)])
            .unwrap();
        Self(path)
    }

    fn settings_files(&self) -> Vec<Option<Vec<u8>>> {
        [
            "settings.v1.json",
            "settings.v1.json.bak",
            "settings.v1.json.tmp",
        ]
        .map(|name| fs::read(self.0.join(name)).ok())
        .to_vec()
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
#[ignore = "subprocess entry for the STDIO regression tests"]
async fn stdio_server_child() {
    let dir = PathBuf::from(std::env::var_os(FIXTURE).unwrap());
    let snapshot = SettingsService::load_for_stdio(&dir).unwrap();
    if std::env::var_os("FSTTY_TEST_PAUSE_AFTER_SETTINGS").is_some() {
        println!("settings-read");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "resume");
    }
    run_stdio(dir, snapshot).await.unwrap();
}

struct Peer {
    process: Child,
    lines: mpsc::Receiver<String>,
    next_id: u32,
}

impl Peer {
    fn start(dir: &Path, pause: bool) -> Self {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "mcp::stdio_regression_tests::stdio_server_child",
            "--ignored",
            "--nocapture",
            "--format",
            "terse",
        ])
        .env(FIXTURE, dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
        if pause {
            cmd.env("FSTTY_TEST_PAUSE_AFTER_SETTINGS", "1");
        }
        let mut process = cmd.spawn().unwrap();
        let stdout = process.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            process,
            lines,
            next_id: 0,
        }
    }

    fn send(&mut self, line: impl std::fmt::Display) {
        writeln!(self.process.stdin.as_mut().unwrap(), "{line}").unwrap();
    }

    fn line(&self) -> String {
        self.lines.recv_timeout(Duration::from_secs(15)).unwrap()
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        self.send(json!({"jsonrpc":"2.0", "id":self.next_id, "method":method, "params":params}));
        loop {
            if let Ok(value) = serde_json::from_str::<Value>(&self.line()) {
                if value["id"] == self.next_id {
                    return value;
                }
            }
        }
    }

    fn initialize(&mut self) {
        let result = self.request("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"regression","version":"1"}}));
        assert!(result["result"].is_object(), "{result}");
        self.send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    }

    fn tool(&mut self, name: &str, args: Value) -> Value {
        self.request("tools/call", json!({"name":name, "arguments":args}))
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

struct Counter(Arc<AtomicUsize>);

impl server::Handler for Counter {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        session.close(channel)
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        session.channel_success(channel)?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)
    }
}

async fn ssh_server(dir: &Path) -> (u16, Arc<AtomicUsize>) {
    let config = fstty_broker::proxy::server_config().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    russh::keys::known_hosts::learn_known_hosts_path(
        "127.0.0.1",
        port,
        config.keys[0].public_key(),
        dir.join("known_hosts"),
    )
    .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let commands = count.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let handler = Counter(commands.clone());
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    (port, count)
}

fn result(response: Value) -> Value {
    assert!(
        response["error"].is_null() && response["result"]["isError"] != true,
        "{response}"
    );
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn assert_denied(response: Value) {
    assert!(
        response["error"].is_object() || response["result"]["isError"] == true,
        "{response}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_reauthorizes_a_live_ssh_lease() {
    let dir = Directory::enabled();
    let id = Uuid::new_v4().to_string();
    tests::write_test_session(&dir.0, &id);
    let old = dir.0.join("sessions.v1.json");
    let main = dir.0.join("sessions.v2.json");
    let mut profile: Value = serde_json::from_slice(&fs::read(&old).unwrap()).unwrap();
    let (first, first_count) = ssh_server(&dir.0).await;
    let (second, second_count) = ssh_server(&dir.0).await;
    profile["sessions"][0]["port"] = json!(first);
    fs::write(&old, profile.to_string()).unwrap();
    let mut peer = Peer::start(&dir.0, false);
    peer.initialize();
    assert_eq!(result(peer.tool("list_sessions", json!({})))[0]["id"], id);
    let args = json!({"sessionId":id});
    let command = json!({"sessionId":id, "command":"pwd"});
    result(peer.tool("get_command_policy", args.clone()));
    result(peer.tool("execute_command", command.clone()));
    assert_eq!(first_count.load(Ordering::SeqCst), 1);
    profile["version"] = json!(2);
    profile["sessions"][0]["group"] = json!("restricted");
    fs::write(&main, profile.to_string()).unwrap();
    assert_eq!(result(peer.tool("list_sessions", json!({}))), json!([]));
    assert_denied(peer.tool("get_command_policy", args.clone()));
    assert_denied(peer.tool("execute_command", command.clone()));
    profile["sessions"][0]["group"] = json!("生产");
    profile["sessions"][0]["port"] = json!(second);
    fs::write(&main, profile.to_string()).unwrap();
    result(peer.tool("execute_command", command.clone()));
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
    let mut policies = crate::services::McpCommandPolicyService::load(&dir.0, vec![]);
    policies
        .replace_all(vec![tests::mcp_permission(false)])
        .unwrap();
    assert_eq!(
        peer.tool("execute_command", command.clone())["error"]["code"],
        -32600
    );
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
    policies
        .replace_all(vec![tests::mcp_permission(true)])
        .unwrap();
    // Returning to the old target must perform a new handshake, even if its idle lease survives.
    fs::remove_file(dir.0.join("known_hosts")).unwrap();
    let wrong = fstty_broker::proxy::server_config().unwrap();
    russh::keys::known_hosts::learn_known_hosts_path(
        "127.0.0.1",
        first,
        wrong.keys[0].public_key(),
        dir.0.join("known_hosts"),
    )
    .unwrap();
    profile["sessions"][0]["port"] = json!(first);
    fs::write(&main, profile.to_string()).unwrap();
    let rejected = peer.tool("execute_command", command.clone());
    assert_denied(rejected);
    profile["sessions"][0]["port"] = json!(second);
    fs::write(&main, profile.to_string()).unwrap();
    fs::write(dir.0.join("sessions.v2.json.bak"), profile.to_string()).unwrap();
    fs::write(&main, "broken").unwrap();
    assert_denied(peer.tool("list_sessions", json!({})));
    assert_denied(peer.tool("execute_command", command.clone()));
    fs::remove_file(&main).unwrap();
    assert_denied(peer.tool("get_command_policy", args.clone()));
    profile["sessions"] = json!([]);
    fs::write(&main, profile.to_string()).unwrap();
    assert_denied(peer.tool("execute_command", command));
    assert_eq!(first_count.load(Ordering::SeqCst), 1);
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
}

#[test]
fn stdio_startup_preserves_concurrent_gui_edits() {
    let dir = Directory::enabled();
    let mut peer = Peer::start(&dir.0, true);
    while !peer.line().contains("settings-read") {}
    let mut gui = SettingsService::load(&dir.0);
    gui.update_mcp_transport(false, false, 37653).unwrap();
    gui.set_terminal_font_size(22).unwrap();
    let expected = dir.settings_files();
    peer.send("resume");
    peer.initialize();
    assert_denied(peer.tool("list_sessions", json!({})));
    assert_eq!(expected, dir.settings_files());
    let saved = SettingsService::load(&dir.0).get();
    assert!(!saved.mcp_enabled);
    assert_eq!(saved.terminal_font_size, 22);
}

#[test]
fn failed_policy_migration_preserves_legacy_for_retry_and_disabled_stdio_skips_database() {
    let dir = Directory::enabled();
    let db = dir.0.join("mcp-command-policy.v1.db");
    let expected = dir.settings_files();
    fs::create_dir(&db).unwrap();
    let failed = AppState::new(dir.0.clone());
    assert!(failed
        .mcp_command_policy_service
        .lock()
        .unwrap()
        .list_permissions()
        .is_err());
    assert_eq!(expected, dir.settings_files());
    drop(failed);
    fs::remove_dir(&db).unwrap();
    let mut gui = SettingsService::load(&dir.0);
    gui.update_mcp_transport(false, false, 37653).unwrap();
    let disabled = dir.settings_files();
    assert!(SettingsService::load_for_stdio(&dir.0).is_err());
    assert!(!db.exists());
    assert_eq!(disabled, dir.settings_files());
    gui.update_mcp_transport(true, false, 37653).unwrap();
    let state = AppState::new(dir.0.clone());
    assert_eq!(
        state
            .mcp_command_policy_service
            .lock()
            .unwrap()
            .list_permissions()
            .unwrap(),
        vec![tests::mcp_permission(true)]
    );
    assert!(SettingsService::load(&dir.0)
        .get()
        .mcp_group_permissions
        .is_empty());
}

#[test]
fn stdio_first_and_repeated_policy_migration_leave_json_untouched() {
    let dir = Directory::enabled();
    let expected = dir.settings_files();
    let mut first = Peer::start(&dir.0, true);
    let mut second = Peer::start(&dir.0, true);
    for peer in [&first, &second] {
        while !peer.line().contains("settings-read") {}
    }
    first.send("resume");
    second.send("resume");
    first.initialize();
    second.initialize();
    for peer in [&mut first, &mut second] {
        assert_eq!(result(peer.tool("list_sessions", json!({}))), json!([]));
    }
    let mut third = Peer::start(&dir.0, false);
    third.initialize();
    assert_eq!(expected, dir.settings_files());
    let gui = AppState::new(dir.0.clone());
    assert_eq!(
        gui.mcp_command_policy_service
            .lock()
            .unwrap()
            .list_permissions()
            .unwrap()
            .len(),
        1
    );
    assert!(SettingsService::load(&dir.0)
        .get()
        .mcp_group_permissions
        .is_empty());
}
