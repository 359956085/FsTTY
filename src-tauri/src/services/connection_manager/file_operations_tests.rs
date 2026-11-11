use super::*;
use crate::models::{
    PermissionPatch, StartTransferJobRequest, TransferConflictDecision, TransferJobState,
    TransferJobSummary,
};
use crate::services::TransferJobService;
use russh::{server, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode,
};
use std::collections::{BTreeMap, HashMap};
#[derive(Clone)]
struct Node {
    mode: u32,
    bytes: Vec<u8>,
}
#[derive(Default)]
struct MemoryFs {
    entries: BTreeMap<String, Node>,
    changes: Vec<String>,
    permission_delay_ms: u64,
}
type SharedFs = Arc<StdMutex<MemoryFs>>;
struct FixtureServer {
    channels: Vec<russh::Channel<server::Msg>>,
    fs: SharedFs,
}
impl server::Handler for FixtureServer {
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
        let index = self.channels.iter().position(|c| c.id() == id).unwrap();
        let channel = self.channels.remove(index);
        session.channel_success(id)?;
        tokio::spawn(russh_sftp::server::run(
            channel.into_stream(),
            FixtureSftp {
                fs: self.fs.clone(),
                read_dirs: HashMap::new(),
            },
        ));
        Ok(())
    }
}
struct FixtureSftp {
    fs: SharedFs,
    read_dirs: HashMap<String, usize>,
}
fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: String::new(),
    }
}
fn attributes(node: &Node) -> FileAttributes {
    let mut a = FileAttributes::empty();
    a.permissions = Some(node.mode);
    a.size = Some(node.bytes.len() as u64);
    a.uid = Some(1000);
    a.gid = Some(1000);
    a
}
impl russh_sftp::server::Handler for FixtureSftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let fs = self.fs.lock().unwrap();
        let node = fs.entries.get(&path).ok_or(StatusCode::NoSuchFile)?;
        Ok(Attrs {
            id,
            attrs: attributes(node),
        })
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.lstat(id, path).await
    }
    async fn fstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        self.lstat(id, path).await
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if flags.contains(OpenFlags::CREATE) {
            if fs.entries.contains_key(&path) && flags.contains(OpenFlags::EXCLUDE) {
                return Err(StatusCode::Failure);
            }
            fs.entries.entry(path.clone()).or_insert(Node {
                mode: 0o100644,
                bytes: vec![],
            });
        }
        let node = fs.entries.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        if flags.contains(OpenFlags::TRUNCATE) {
            node.bytes.clear();
        }
        Ok(Handle { id, handle: path })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        let fs = self.fs.lock().unwrap();
        let bytes = &fs.entries.get(&handle).ok_or(StatusCode::NoSuchFile)?.bytes;
        let start = offset as usize;
        if start >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: bytes[start..(start + len as usize).min(bytes.len())].to_vec(),
        })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        let bytes = &mut fs
            .entries
            .get_mut(&handle)
            .ok_or(StatusCode::NoSuchFile)?
            .bytes;
        let start = offset as usize;
        bytes.resize(bytes.len().max(start + data.len()), 0);
        bytes[start..start + data.len()].copy_from_slice(&data);
        Ok(ok(id))
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(ok(id))
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let fs = self.fs.lock().unwrap();
        let node = fs.entries.get(&path).ok_or(StatusCode::NoSuchFile)?;
        if node.mode & 0o170000 != 0o040000 {
            return Err(StatusCode::Failure);
        }
        drop(fs);
        self.read_dirs.remove(&path);
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let offset = self.read_dirs.entry(path.clone()).or_default();
        let fs = self.fs.lock().unwrap();
        let prefix = path.trim_end_matches('/').to_owned() + "/";
        let files = fs
            .entries
            .iter()
            .filter_map(|(p, n)| {
                let name = p.strip_prefix(&prefix)?;
                (!name.is_empty() && !name.contains('/')).then(|| File::new(name, attributes(n)))
            })
            .skip(*offset)
            .take(128)
            .collect::<Vec<_>>();
        if files.is_empty() {
            return Err(StatusCode::Eof);
        }
        *offset += files.len();
        Ok(Name { id, files })
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.entries.contains_key(&path) {
            return Err(StatusCode::Failure);
        }
        fs.entries.insert(
            path,
            Node {
                mode: 0o040755,
                bytes: vec![],
            },
        );
        Ok(ok(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        self.fs
            .lock()
            .unwrap()
            .entries
            .remove(&path)
            .ok_or(StatusCode::NoSuchFile)?;
        Ok(ok(id))
    }
    async fn rename(&mut self, id: u32, old: String, new: String) -> Result<Status, Self::Error> {
        let mut fs = self.fs.lock().unwrap();
        if fs.entries.contains_key(&new) {
            return Err(StatusCode::Failure);
        }
        let node = fs.entries.remove(&old).ok_or(StatusCode::NoSuchFile)?;
        fs.entries.insert(new, node);
        Ok(ok(id))
    }
    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attr: FileAttributes,
    ) -> Result<Status, Self::Error> {
        // SETSTAT must never accidentally truncate a file or reset ownership/times.
        assert!(
            attr.size.is_none()
                && attr.uid.is_none()
                && attr.gid.is_none()
                && attr.atime.is_none()
                && attr.mtime.is_none()
        );
        if path.ends_with("denied") {
            return Err(StatusCode::PermissionDenied);
        }
        let delay = self.fs.lock().unwrap().permission_delay_ms;
        if delay > 0 {
            time::sleep(Duration::from_millis(delay)).await;
        }
        let mut fs = self.fs.lock().unwrap();
        let node = fs.entries.get_mut(&path).ok_or(StatusCode::NoSuchFile)?;
        node.mode = (node.mode & !0o7777) | (attr.permissions.unwrap() & 0o7777);
        fs.changes.push(path);
        Ok(ok(id))
    }
}
struct Fixture {
    manager: ConnectionManager,
    connection: String,
    service: TransferJobService,
    fs: SharedFs,
    directory: PathBuf,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("fm-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let fs = Arc::new(StdMutex::new(MemoryFs::default()));
        for (path, mode, bytes) in [
            ("/", 0o040755, b"".as_slice()),
            ("/tree", 0o042755, b""),
            ("/tree/empty", 0o040755, b""),
            ("/tree/one.txt", 0o100644, b"one\0\xff"),
            ("/tree/.hidden", 0o100600, b"hidden"),
            ("/tree/link", 0o120777, b"/outside"),
            ("/out", 0o040755, b""),
        ] {
            fs.lock().unwrap().entries.insert(
                path.into(),
                Node {
                    mode,
                    bytes: bytes.to_vec(),
                },
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = fstty_broker::proxy::server_config().unwrap();
        let known = directory.join("known_hosts");
        learn_known_hosts_path(
            "127.0.0.1",
            address.port(),
            config.keys[0].public_key(),
            &known,
        )
        .unwrap();
        let handler = FixtureServer {
            channels: vec![],
            fs: fs.clone(),
        };
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let run = server::run_stream(config, socket, handler).await.unwrap();
            let _ = run.await;
        });
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            address,
            SshClient {
                broker_transport: false,
                host: "127.0.0.1".into(),
                port: address.port(),
                known_hosts_path: known,
                known_hosts_lock: Arc::new(StdMutex::new(())),
                observation: Arc::new(StdMutex::new(None)),
            },
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("fixture").await.unwrap().success());
        let manager = ConnectionManager::new(&directory);
        let connection = Uuid::new_v4().to_string();
        let mut entry = ConnectionEntry {
            session_id: Uuid::new_v4().to_string(),
            username: "fixture".into(),
            handle: Arc::new(Mutex::new(handle)),
            terminal_tx: None,
            terminal_bridge: None,
            device_metrics: None,
            browser_sftp: None,
        };
        entry.browser_sftp = Some(Arc::new(open_sftp(&entry).await.unwrap()));
        manager
            .inner
            .registry
            .write()
            .await
            .connections
            .insert(connection.clone(), Arc::new(entry));
        Self {
            manager,
            connection,
            service: TransferJobService::default(),
            fs,
            directory,
            server,
        }
    }
    async fn complete(&self, id: &str, decision: TransferConflictDecision) -> TransferJobSummary {
        time::timeout(Duration::from_secs(15), async {
            loop {
                let job = self
                    .service
                    .summaries()
                    .await
                    .into_iter()
                    .find(|j| j.job_id == id)
                    .unwrap();
                if job.state.is_terminal() {
                    return job;
                }
                if job.state == TransferJobState::WaitingForConflict {
                    let _ = self.service.resolve_conflict(id, decision).await;
                }
                time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn close(self) {
        self.manager.disconnect(&self.connection).await.unwrap();
        self.server.abort();
        let path = tokio::fs::canonicalize(&self.directory).await.unwrap();
        let root = tokio::fs::canonicalize(std::env::temp_dir()).await.unwrap();
        assert_eq!(path.parent(), Some(root.as_path()));
        tokio::fs::remove_dir_all(path).await.unwrap();
    }
}
#[tokio::test]
async fn sftp_directory_download_keeps_empty_hidden_and_binary_and_skips_links() {
    let f = Fixture::new().await;
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::DownloadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                remote_paths: vec!["/tree".into(), "/tree/one.txt".into()],
                local_directory: f.directory.to_string_lossy().into_owned(),
            },
        )
        .await
        .unwrap();
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Completed);
    assert_eq!(
        (result.downloaded, result.skipped, result.failed),
        (2, 1, 0)
    );
    assert!(f.directory.join("tree/empty").is_dir());
    assert_eq!(
        tokio::fs::read(f.directory.join("tree/one.txt"))
            .await
            .unwrap(),
        b"one\0\xff"
    );
    assert!(!f.directory.join("tree/link").exists());
    f.close().await;
}
#[tokio::test]
async fn sftp_recursive_permission_patches_preserve_special_bits_and_finish_parents_last() {
    let f = Fixture::new().await;
    f.fs.lock().unwrap().entries.insert(
        "/tree/denied".into(),
        Node {
            mode: 0o100644,
            bytes: vec![],
        },
    );
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::Permissions {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                paths: vec!["/tree".into()],
                recursive: true,
                file_patch: PermissionPatch {
                    mask: 0o777,
                    value: 0o640,
                },
                directory_patch: PermissionPatch {
                    mask: 0o777,
                    value: 0o750,
                },
            },
        )
        .await
        .unwrap();
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Completed);
    assert_eq!(result.failed, 1);
    assert_eq!(result.details.changed_permissions, 4);
    {
        let fs = f.fs.lock().unwrap();
        assert_eq!(fs.entries["/tree"].mode, 0o042750);
        assert_eq!(fs.entries["/tree/one.txt"].mode, 0o100640);
        assert_eq!(fs.entries["/tree/link"].mode, 0o120777);
        assert_eq!(fs.changes.last().unwrap(), "/tree");
        assert_eq!(fs.entries["/tree/one.txt"].bytes, b"one\0\xff");
    }
    f.close().await;
}
#[tokio::test]
async fn sftp_folder_upload_merges_and_keeps_existing_content_then_handles_file_conflicts() {
    let f = Fixture::new().await;
    let source = f.directory.join("upload");
    tokio::fs::create_dir_all(source.join("empty"))
        .await
        .unwrap();
    tokio::fs::write(source.join("中文.bin"), b"binary\0\xff")
        .await
        .unwrap();
    {
        let mut fs = f.fs.lock().unwrap();
        fs.entries.insert(
            "/out/upload".into(),
            Node {
                mode: 0o040755,
                bytes: vec![],
            },
        );
        fs.entries.insert(
            "/out/upload/keep".into(),
            Node {
                mode: 0o100644,
                bytes: b"keep".to_vec(),
            },
        );
    }
    for decision in [
        TransferConflictDecision::Skip,
        TransferConflictDecision::Skip,
        TransferConflictDecision::Overwrite,
    ] {
        let job = f
            .service
            .start(
                f.manager.clone(),
                StartTransferJobRequest::UploadBatch {
                    runtime_id: Uuid::new_v4().to_string(),
                    connection_id: f.connection.clone(),
                    local_paths: vec![
                        source.to_string_lossy().into_owned(),
                        source.join("中文.bin").to_string_lossy().into_owned(),
                    ],
                    remote_directory: "/out".into(),
                },
            )
            .await
            .unwrap();
        let result = f.complete(&job.job_id, decision).await;
        assert_eq!(result.state, TransferJobState::Completed);
        assert_eq!(result.failed, 0);
    }
    {
        let fs = f.fs.lock().unwrap();
        assert!(fs.entries.contains_key("/out/upload/empty"));
        assert_eq!(fs.entries["/out/upload/中文.bin"].bytes, b"binary\0\xff");
        assert_eq!(fs.entries["/out/upload/keep"].bytes, b"keep");
        assert!(!fs
            .entries
            .keys()
            .any(|p| p.ends_with(".part") || p.ends_with(".bak")));
    }
    f.close().await;
}
#[tokio::test]
async fn sftp_folder_download_rejects_type_conflicts_without_replacing_existing_files() {
    let f = Fixture::new().await;
    tokio::fs::write(f.directory.join("tree"), b"existing")
        .await
        .unwrap();
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::DownloadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                remote_paths: vec!["/tree".into()],
                local_directory: f.directory.to_string_lossy().into_owned(),
            },
        )
        .await
        .unwrap();
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Failed);
    assert!(result.failed > 0);
    assert_eq!(
        tokio::fs::read(f.directory.join("tree")).await.unwrap(),
        b"existing"
    );
    f.close().await;
}
#[tokio::test]
async fn sftp_cancelled_scan_does_not_create_upload_destinations() {
    let f = Fixture::new().await;
    let source = f.directory.join("cancelled");
    tokio::fs::create_dir_all(&source).await.unwrap();
    tokio::fs::write(source.join("one"), b"data").await.unwrap();
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::UploadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                local_paths: vec![source.to_string_lossy().into_owned()],
                remote_directory: "/out".into(),
            },
        )
        .await
        .unwrap();
    assert!(f.service.cancel(&f.manager, &job.job_id).await);
    assert_eq!(
        f.complete(&job.job_id, TransferConflictDecision::Cancel)
            .await
            .state,
        TransferJobState::Cancelled
    );
    assert!(!f.fs.lock().unwrap().entries.contains_key("/out/cancelled"));
    f.close().await;
}

#[tokio::test]
async fn sftp_preflight_rejects_invalid_or_colliding_names_before_writes() {
    let f = Fixture::new().await;
    for names in [["bad:name", "valid"], ["Same.txt", "same.txt"]] {
        if !cfg!(windows) && names[0] == "Same.txt" {
            continue;
        }
        {
            let mut fs = f.fs.lock().unwrap();
            for name in names {
                fs.entries.insert(
                    format!("/tree/{name}"),
                    Node {
                        mode: 0o100644,
                        bytes: vec![],
                    },
                );
            }
        }
        let job = f
            .service
            .start(
                f.manager.clone(),
                StartTransferJobRequest::DownloadBatch {
                    runtime_id: Uuid::new_v4().to_string(),
                    connection_id: f.connection.clone(),
                    remote_paths: vec!["/tree".into()],
                    local_directory: f.directory.to_string_lossy().into_owned(),
                },
            )
            .await
            .unwrap();
        let result = f
            .complete(&job.job_id, TransferConflictDecision::Skip)
            .await;
        assert_eq!(result.state, TransferJobState::Failed);
        assert!(!f.directory.join("tree").exists());
        {
            let mut fs = f.fs.lock().unwrap();
            for name in names {
                fs.entries.remove(&format!("/tree/{name}"));
            }
        }
    }
    f.close().await;
}
#[tokio::test]
async fn sftp_upload_preflight_rejects_equal_root_names_without_remote_writes() {
    let f = Fixture::new().await;
    for parent in ["one", "two"] {
        tokio::fs::create_dir_all(f.directory.join(parent).join("same"))
            .await
            .unwrap();
    }
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::UploadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                local_paths: ["one/same", "two/same"]
                    .into_iter()
                    .map(|p| f.directory.join(p).to_string_lossy().into_owned())
                    .collect(),
                remote_directory: "/out".into(),
            },
        )
        .await
        .unwrap();
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Failed);
    assert!(!f.fs.lock().unwrap().entries.contains_key("/out/same"));
    f.close().await;
}

#[tokio::test]
async fn sftp_scan_limits_are_rejected_before_creating_destinations() {
    let f = Fixture::new().await;
    {
        let mut fs = f.fs.lock().unwrap();
        for index in 0..10_001 {
            fs.entries.insert(
                format!("/tree/item{index:05}"),
                Node {
                    mode: 0o100644,
                    bytes: vec![],
                },
            );
        }
    }
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::DownloadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                remote_paths: vec!["/tree".into()],
                local_directory: f.directory.to_string_lossy().into_owned(),
            },
        )
        .await
        .unwrap();
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Failed);
    assert!(!f.directory.join("tree").exists());
    {
        let mut fs = f.fs.lock().unwrap();
        fs.entries.retain(|name, _| !name.starts_with("/tree/item"));
        let mut path = String::from("/tree");
        for _ in 0..65 {
            path.push_str("/d");
            fs.entries.insert(
                path.clone(),
                Node {
                    mode: 0o040755,
                    bytes: vec![],
                },
            );
        }
    }
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::DownloadBatch {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                remote_paths: vec!["/tree".into()],
                local_directory: f.directory.to_string_lossy().into_owned(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        f.complete(&job.job_id, TransferConflictDecision::Skip)
            .await
            .state,
        TransferJobState::Failed
    );
    assert!(!f.directory.join("tree").exists());
    f.close().await;
}

#[tokio::test]
async fn sftp_permission_cancel_preserves_completed_changes_and_summary_can_reattach() {
    let f = Fixture::new().await;
    {
        let mut fs = f.fs.lock().unwrap();
        fs.permission_delay_ms = 40;
        for index in 0..15 {
            fs.entries.insert(
                format!("/tree/entry{index}"),
                Node {
                    mode: 0o100644,
                    bytes: vec![],
                },
            );
        }
    }
    let job = f
        .service
        .start(
            f.manager.clone(),
            StartTransferJobRequest::Permissions {
                runtime_id: Uuid::new_v4().to_string(),
                connection_id: f.connection.clone(),
                paths: vec!["/tree".into()],
                recursive: true,
                file_patch: PermissionPatch {
                    mask: 0o777,
                    value: 0o600,
                },
                directory_patch: PermissionPatch::default(),
            },
        )
        .await
        .unwrap();
    time::timeout(Duration::from_secs(5), async {
        loop {
            if !f.fs.lock().unwrap().changes.is_empty() {
                break;
            }
            time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let attached = f
        .service
        .attach(&job.job_id, tauri::ipc::Channel::new(|_| Ok(())))
        .await
        .unwrap();
    assert_eq!(
        attached.direction,
        crate::models::TransferJobDirection::Permissions
    );
    assert!(f.service.cancel(&f.manager, &job.job_id).await);
    let result = f
        .complete(&job.job_id, TransferConflictDecision::Skip)
        .await;
    assert_eq!(result.state, TransferJobState::Cancelled);
    assert!(result.details.changed_permissions > 0);
    assert!(result.details.processed_items < result.details.item_total);
    assert_eq!(
        f.fs.lock().unwrap().changes.len(),
        result.details.changed_permissions as usize
    );
    f.close().await;
}
