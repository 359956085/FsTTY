use super::*;
use russh::keys::ssh_key::{private::Ed25519Keypair, PrivateKey};
use russh::{server, ChannelId};
use tokio::task::JoinHandle;

const SNAPSHOT: &str = "__FSTTY_CPU_FIRST__\ncpu 100 0 0 100\ncpu0 100 0 0 100\n__FSTTY_CPU_SECOND__\ncpu 200 0 0 100\ncpu0 200 0 0 100\n__FSTTY_MEMORY__\nMemTotal: 2048 kB\nMemAvailable: 1024 kB\n";

#[derive(Debug, PartialEq)]
enum ServerEvent {
    Requested,
    Closed,
}

struct DeviceServer {
    events: mpsc::UnboundedSender<ServerEvent>,
    hold_response: bool,
}

impl server::Handler for DeviceServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.events.send(ServerEvent::Requested);
        session.channel_success(channel)?;
        if !self.hold_response {
            session.data(channel, SNAPSHOT.as_bytes().to_vec())?;
            session.exit_status_request(channel, 0)?;
            // 不主动关闭，以验证客户端在成功、超时或取消后发送关闭消息。
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        _channel: ChannelId,
        _session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.events.send(ServerEvent::Closed);
        Ok(())
    }
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("fstty-device-metrics-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    manager: ConnectionManager,
    connection_id: String,
    entry: Arc<ConnectionEntry>,
    events: mpsc::UnboundedReceiver<ServerEvent>,
    server: JoinHandle<()>,
    _directory: TestDirectory,
}

impl Fixture {
    async fn new(gui: bool, hold_response: bool) -> Self {
        let directory = TestDirectory::new();
        let manager = ConnectionManager::new(&directory.0);
        // 固定种子只用于隔离的内存 SSH 测试，不生成或读取任何用户凭据。
        let key = PrivateKey::from(Ed25519Keypair::from_seed(&[7; 32]));
        let profile = StoredSession {
            id: "session".to_owned(),
            name: "设备统计测试".to_owned(),
            host: "device.test".to_owned(),
            port: 22,
            username: "test".to_owned(),
            group: String::new(),
            tags: vec![],
            auth: SessionAuth::Password,
            login_save_prompted: false,
        };
        learn_known_hosts_path(
            &profile.host,
            profile.port,
            key.public_key(),
            &manager.inner.known_hosts_path,
        )
        .unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            ..server::Config::default()
        });
        let (events, receiver) = mpsc::unbounded_channel();
        let (client_stream, server_stream) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let session = server::run_stream(
                config,
                server_stream,
                DeviceServer {
                    events,
                    hold_response,
                },
            )
            .await
            .unwrap();
            let _ = session.await;
        });
        let (handler, _) = manager.ssh_client(&profile);
        let mut handle = time::timeout(
            Duration::from_secs(5),
            client::connect_stream(Arc::new(client::Config::default()), client_stream, handler),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(handle
            .authenticate_none(&profile.username)
            .await
            .unwrap()
            .success());
        let connection_id = Uuid::new_v4().to_string();
        let entry = Arc::new(ConnectionEntry {
            session_id: profile.id,
            username: profile.username,
            handle: Arc::new(Mutex::new(handle)),
            terminal_tx: None,
            terminal_bridge: None,
            device_metrics: gui.then(|| DeviceMetricsMonitor::new(connection_id.clone())),
            browser_sftp: None,
        });
        manager
            .register_connection(connection_id.clone(), entry.clone())
            .await;
        Self {
            manager,
            connection_id,
            entry,
            events: receiver,
            server,
            _directory: directory,
        }
    }

    async fn event(&mut self) -> ServerEvent {
        time::timeout(Duration::from_secs(5), self.events.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn start(&self) {
        self.manager.start_device_metrics(&self.connection_id).await;
    }

    async fn snapshot(&self) -> DeviceMetricsSnapshot {
        time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = self
                    .manager
                    .device_metrics_snapshot(&self.connection_id)
                    .await
                    .unwrap();
                if !snapshot.history.is_empty() {
                    return snapshot;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(metrics) = &self.entry.device_metrics {
            let _ = metrics.stop();
        }
        self.server.abort();
    }
}

#[tokio::test]
async fn gui_connection_has_one_sampler_and_snapshot_reads_never_execute_commands() {
    let mut fixture = Fixture::new(true, false).await;
    fixture.start().await;
    fixture.start().await;
    assert_eq!(fixture.event().await, ServerEvent::Requested);
    assert_eq!(fixture.event().await, ServerEvent::Closed);
    let snapshot = fixture.snapshot().await;
    assert_eq!(snapshot.history.len(), 1);
    assert_eq!(snapshot.history[0].cpu_percent, Some(100));
    assert_eq!(snapshot.history[0].memory_percent, Some(50));
    for _ in 0..3 {
        assert_eq!(fixture.snapshot().await.history, snapshot.history);
    }
    assert!(fixture.events.try_recv().is_err());
    fixture
        .manager
        .disconnect(&fixture.connection_id)
        .await
        .unwrap();
    assert!(fixture
        .manager
        .device_metrics_snapshot(&fixture.connection_id)
        .await
        .is_err());
    assert!(fixture
        .entry
        .device_metrics
        .as_ref()
        .unwrap()
        .snapshot()
        .is_err());
}

#[tokio::test]
async fn headless_connections_keep_on_demand_status_without_a_gui_sampler() {
    let mut fixture = Fixture::new(false, false).await;
    fixture.start().await;
    assert!(fixture.entry.device_metrics.is_none());
    assert!(fixture.events.try_recv().is_err());
    assert!(fixture
        .manager
        .device_metrics_snapshot(&fixture.connection_id)
        .await
        .is_err());
    let status = DeviceService
        .status(&fixture.manager, &fixture.connection_id)
        .await
        .unwrap();
    assert!(status.available);
    assert_eq!(fixture.event().await, ServerEvent::Requested);
    assert_eq!(fixture.event().await, ServerEvent::Closed);
    fixture
        .manager
        .disconnect(&fixture.connection_id)
        .await
        .unwrap();
}

#[tokio::test]
async fn shutdown_closes_inflight_sampling_without_disconnect_or_restart() {
    let mut fixture = Fixture::new(true, true).await;
    fixture.start().await;
    assert_eq!(fixture.event().await, ServerEvent::Requested);
    fixture.manager.shutdown_device_metrics().await;
    fixture.manager.shutdown_device_metrics().await;
    assert_eq!(fixture.event().await, ServerEvent::Closed);
    assert_eq!(
        fixture
            .manager
            .session_id(&fixture.connection_id)
            .await
            .unwrap(),
        "session"
    );
    assert!(fixture
        .manager
        .device_metrics_snapshot(&fixture.connection_id)
        .await
        .is_err());
    fixture.start().await;
    tokio::task::yield_now().await;
    assert!(fixture.events.try_recv().is_err());
    fixture
        .manager
        .disconnect(&fixture.connection_id)
        .await
        .unwrap();
}

#[tokio::test]
async fn terminal_disconnect_and_session_deletion_both_clear_metrics() {
    for natural_disconnect in [true, false] {
        let mut fixture = Fixture::new(true, true).await;
        fixture.start().await;
        assert_eq!(fixture.event().await, ServerEvent::Requested);
        if natural_disconnect {
            fixture
                .manager
                .finish_connection(&fixture.connection_id)
                .await;
        } else {
            fixture.manager.disconnect_session("session").await;
        }
        assert!(fixture
            .manager
            .device_metrics_snapshot(&fixture.connection_id)
            .await
            .is_err());
        let metrics = fixture.entry.device_metrics.as_ref().unwrap();
        assert!(metrics.snapshot().is_err());
        assert!(metrics.stop().is_none());
        fixture.start().await;
        assert!(metrics.stop().is_none());
    }
}

#[tokio::test]
async fn cancelling_a_device_command_closes_the_channel_but_keeps_ssh_alive() {
    let mut fixture = Fixture::new(false, true).await;
    let manager = fixture.manager.clone();
    let connection_id = fixture.connection_id.clone();
    let request = tokio::spawn(async move { DeviceService.status(&manager, &connection_id).await });
    assert_eq!(fixture.event().await, ServerEvent::Requested);
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.event().await, ServerEvent::Closed);
    assert!(fixture
        .manager
        .session_id(&fixture.connection_id)
        .await
        .is_ok());
    fixture
        .manager
        .disconnect(&fixture.connection_id)
        .await
        .unwrap();
}
