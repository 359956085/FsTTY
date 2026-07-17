use crate::models::AppError;
#[cfg(not(target_os = "windows"))]
use keyring::v1::{Entry, Error as KeyringError};
#[cfg(target_os = "windows")]
use keyring_core::{api::CredentialStoreApi, Entry, Error as KeyringError};
use std::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::oneshot;
#[cfg(target_os = "windows")]
use windows_native_keyring_store::Store;
use zeroize::Zeroizing;

const CREDENTIAL_SERVICE: &str = "com.fengshi.fstty";
const MAX_CREDENTIAL_LENGTH: usize = 16 * 1024;

type CredentialResult<T> = Result<T, AppError>;

enum CredentialRequest {
    Get {
        account: String,
        response: oneshot::Sender<CredentialResult<Option<Zeroizing<String>>>>,
    },
    Set {
        account: String,
        value: Zeroizing<String>,
        response: oneshot::Sender<CredentialResult<()>>,
    },
    Delete {
        account: String,
        response: oneshot::Sender<CredentialResult<()>>,
    },
}

#[derive(Clone)]
pub struct CredentialService {
    sender: Sender<CredentialRequest>,
}

impl Default for CredentialService {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialService {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        // Windows 凭据后端不保证跨线程操作同一条目时的可见顺序，因此固定由一个线程处理。
        let _ = std::thread::Builder::new()
            .name("fstty-credentials".to_owned())
            .spawn(move || run_worker(receiver));
        Self { sender }
    }

    pub async fn get(&self, session_id: &str) -> CredentialResult<Option<Zeroizing<String>>> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::Get {
                account: credential_account(session_id),
                response,
            })
            .map_err(|_| credential_error("读取"))?;
        receiver.await.map_err(|_| credential_error("读取"))?
    }

    pub async fn set(&self, session_id: &str, value: Zeroizing<String>) -> CredentialResult<()> {
        if value.is_empty() || value.len() > MAX_CREDENTIAL_LENGTH {
            return Err(AppError::Validation(
                "密码或私钥口令不能为空，且不能超过 16384 字节".to_owned(),
            ));
        }

        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::Set {
                account: credential_account(session_id),
                value,
                response,
            })
            .map_err(|_| credential_error("保存"))?;
        receiver.await.map_err(|_| credential_error("保存"))?
    }

    pub async fn delete(&self, session_id: &str) -> CredentialResult<()> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::Delete {
                account: credential_account(session_id),
                response,
            })
            .map_err(|_| credential_error("删除"))?;
        receiver.await.map_err(|_| credential_error("删除"))?
    }
}

struct CredentialBackend {
    #[cfg(target_os = "windows")]
    store: std::sync::Arc<Store>,
}

impl CredentialBackend {
    fn new() -> CredentialResult<Self> {
        #[cfg(target_os = "windows")]
        {
            Store::new()
                .map(|store| Self { store })
                .map_err(|_| credential_error("初始化"))
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self {})
        }
    }

    fn get(&self, account: &str) -> CredentialResult<Option<Zeroizing<String>>> {
        let entry = self.entry(account)?;
        read_entry(&entry)
    }

    fn set(&self, account: &str, value: Zeroizing<String>) -> CredentialResult<()> {
        let entry = self.entry(account)?;
        let previous = read_entry(&entry)?;
        entry
            .set_password(&value)
            .map_err(|_| credential_error("保存"))?;

        match read_entry(&entry) {
            Ok(Some(saved)) if saved.as_str() == value.as_str() => Ok(()),
            _ => {
                // 写后校验失败必须恢复旧值，不能让会话配置与系统凭据处于不一致状态。
                restore_entry(&entry, previous).map_err(|_| {
                    AppError::Credential("系统凭据库保存校验失败，且旧凭据恢复失败".to_owned())
                })?;
                Err(AppError::Credential("系统凭据库保存校验失败".to_owned()))
            }
        }
    }

    fn delete(&self, account: &str) -> CredentialResult<()> {
        let entry = self.entry(account)?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(credential_error("删除")),
        }
    }

    #[cfg(target_os = "windows")]
    fn entry(&self, account: &str) -> CredentialResult<Entry> {
        let modifiers = std::collections::HashMap::from([("persistence", "local")]);
        self.store
            .build(CREDENTIAL_SERVICE, account, Some(&modifiers))
            .map_err(|_| credential_error("初始化"))
    }

    #[cfg(not(target_os = "windows"))]
    fn entry(&self, account: &str) -> CredentialResult<Entry> {
        Entry::new(CREDENTIAL_SERVICE, account).map_err(|_| credential_error("初始化"))
    }
}

fn run_worker(receiver: Receiver<CredentialRequest>) {
    let backend = CredentialBackend::new();
    while let Ok(request) = receiver.recv() {
        match request {
            CredentialRequest::Get { account, response } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.get(&account));
                let _ = response.send(result);
            }
            CredentialRequest::Set {
                account,
                value,
                response,
            } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.set(&account, value));
                let _ = response.send(result);
            }
            CredentialRequest::Delete { account, response } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.delete(&account));
                let _ = response.send(result);
            }
        }
    }
}

fn read_entry(entry: &Entry) -> CredentialResult<Option<Zeroizing<String>>> {
    match entry.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err(credential_error("读取")),
    }
}

fn restore_entry(entry: &Entry, previous: Option<Zeroizing<String>>) -> CredentialResult<()> {
    match previous {
        Some(value) => entry
            .set_password(&value)
            .map_err(|_| credential_error("恢复")),
        None => match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(credential_error("恢复")),
        },
    }
}

fn credential_account(session_id: &str) -> String {
    format!("session:{session_id}")
}

fn credential_error(action: &str) -> AppError {
    AppError::Credential(format!("系统凭据库{action}失败"))
}
