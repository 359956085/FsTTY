use super::*;
use crate::{
    models::{StartTransferJobRequest, TransferJobState},
    services::TransferJobService,
};
use russh::{server, ChannelId};
use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, OpenFlags, Status, StatusCode};
use tokio::sync::Semaphore;

const CONTENT: &[u8] = b"FsTTY batch download fixture\0\xff";

struct DownloadServer {
    channels: Vec<russh::Channel<server::Msg>>,
    gate: Arc<Semaphore>,
    started: mpsc::UnboundedSender<String>,
}

impl server::Handler for DownloadServer {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.push(channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            return session.channel_failure(id);
        }
        let index = self
            .channels
            .iter()
            .position(|channel| channel.id() == id)
            .unwrap();
        let channel = self.channels.remove(index);
        session.channel_success(id)?;
        tokio::spawn(russh_sftp::server::run(
            channel.into_stream(),
            DownloadSftp {
                gate: self.gate.clone(),
                started: self.started.clone(),
            },
        ));
        Ok(())
    }
}

struct DownloadSftp {
    gate: Arc<Semaphore>,
    started: mpsc::UnboundedSender<String>,
}

fn attributes(id: u32) -> Attrs {
    Attrs {
        id,
        attrs: FileAttributes {
            size: Some(CONTENT.len() as u64),
            permissions: Some(0o100644),
            ..Default::default()
        },
    }
}

impl russh_sftp::server::Handler for DownloadSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn lstat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        Ok(attributes(id))
    }
    async fn stat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        Ok(attributes(id))
    }
    async fn fstat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        Ok(attributes(id))
    }
    async fn open(
        &mut self,
        id: u32,
        filename: String,
        _: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        Ok(Handle {
            id,
            handle: filename,
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        if offset == 0 {
            self.started.send(handle).unwrap();
            self.gate.acquire().await.unwrap().forget();
        }
        let start = offset as usize;
        if start >= CONTENT.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: CONTENT[start..(start + len as usize).min(CONTENT.len())].to_vec(),
        })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}

#[tokio::test]
async fn 真实本机_sftp_批量下载同时传输五个文件并排队后续文件() {
    time::timeout(Duration::from_secs(15), async {
        let directory = std::env::temp_dir().join(format!("fstty-batch-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = fstty_broker::proxy::server_config().unwrap();
        let known_hosts_path = directory.join("known_hosts");
        learn_known_hosts_path(
            "127.0.0.1",
            address.port(),
            config.keys[0].public_key(),
            &known_hosts_path,
        )
        .unwrap();
        let gate = Arc::new(Semaphore::new(0));
        let (started, mut starts) = mpsc::unbounded_channel();
        let handler = DownloadServer {
            channels: vec![],
            gate: gate.clone(),
            started,
        };
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let running = server::run_stream(config, socket, handler).await.unwrap();
            let _ = running.await;
        });
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            address,
            SshClient {
                broker_transport: false,
                host: "127.0.0.1".to_owned(),
                port: address.port(),
                known_hosts_path,
                known_hosts_lock: Arc::new(StdMutex::new(())),
                observation: Arc::new(StdMutex::new(None)),
            },
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("fixture").await.unwrap().success());
        let manager = ConnectionManager::new(&directory);
        let connection_id = Uuid::new_v4().to_string();
        manager.inner.registry.write().await.connections.insert(
            connection_id.clone(),
            Arc::new(ConnectionEntry {
                session_id: Uuid::new_v4().to_string(),
                username: "fixture".to_owned(),
                handle: Arc::new(Mutex::new(handle)),
                terminal_tx: None,
                terminal_bridge: None,
                device_metrics: None,
                browser_sftp: None,
            }),
        );
        let service = TransferJobService::default();
        let remote_paths = (0..7)
            .map(|index| format!("/{index}.txt"))
            .collect::<Vec<_>>();
        let job = service
            .start(
                manager.clone(),
                StartTransferJobRequest::DownloadBatch {
                    runtime_id: Uuid::new_v4().to_string(),
                    connection_id: connection_id.clone(),
                    remote_paths: remote_paths.clone(),
                    local_directory: directory.to_str().unwrap().to_owned(),
                },
            )
            .await
            .unwrap();
        let mut first = Vec::new();
        for _ in 0..5 {
            first.push(starts.recv().await.unwrap());
        }
        first.sort();
        assert_eq!(first, remote_paths[..5]);
        assert!(time::timeout(Duration::from_millis(80), starts.recv())
            .await
            .is_err());
        let snapshot = service.summaries().await.pop().unwrap();
        assert_eq!((snapshot.active_count, snapshot.queued_count), (5, 2));
        gate.add_permits(1);
        assert_eq!(starts.recv().await.as_deref(), Some("/5.txt"));
        gate.add_permits(6);
        loop {
            let snapshot = service.summaries().await.pop().unwrap();
            if snapshot.state.is_terminal() {
                assert_eq!(snapshot.state, TransferJobState::Completed);
                assert_eq!((snapshot.downloaded, snapshot.failed), (7, 0));
                break;
            }
            time::sleep(Duration::from_millis(5)).await;
        }
        for index in 0..7 {
            assert_eq!(
                tokio::fs::read(directory.join(format!("{index}.txt")))
                    .await
                    .unwrap(),
                CONTENT
            );
        }
        assert!(std::fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part")));
        service.acknowledge(&job.job_id).await.unwrap();
        manager.disconnect(&connection_id).await.unwrap();
        server.abort();
        let cleanup_directory = tokio::fs::canonicalize(&directory).await.unwrap();
        let cleanup_root = tokio::fs::canonicalize(std::env::temp_dir()).await.unwrap();
        assert_eq!(cleanup_directory.parent(), Some(cleanup_root.as_path()));
        tokio::fs::remove_dir_all(directory).await.unwrap();
    })
    .await
    .expect("批量 SFTP 下载不能被单传输限制阻断或停滞");
}
