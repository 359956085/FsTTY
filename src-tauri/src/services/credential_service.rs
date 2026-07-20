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
const WINDOWS_CREDENTIAL_BLOB_BYTES: usize = 2_560;
const MAX_INLINE_PRIVATE_KEY_BYTES: usize = 16 * 1024;
const PRIVATE_KEY_CHUNK_UTF16_BYTES: usize = 2 * 1024;
const MAX_PRIVATE_KEY_CHUNKS: usize = 16;
const PRIVATE_KEY_MANIFEST_VERSION: u8 = 1;
const DAMAGED_PRIVATE_KEY_MESSAGE: &str = "系统凭据库中的私钥分块或清单已损坏，请重新粘贴私钥";

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
    GetPrivateKey {
        session_id: String,
        response: oneshot::Sender<CredentialResult<Option<Zeroizing<String>>>>,
    },
    SetPrivateKey {
        session_id: String,
        value: Zeroizing<String>,
        response: oneshot::Sender<CredentialResult<()>>,
    },
    DeletePrivateKey {
        session_id: String,
        response: oneshot::Sender<CredentialResult<()>>,
    },
    DeleteAll {
        session_id: String,
        response: oneshot::Sender<CredentialResult<()>>,
    },
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateKeyManifest {
    version: u8,
    chunk_count: usize,
    byte_length: usize,
    checksum: String,
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
        if value.is_empty()
            || value.len() > MAX_CREDENTIAL_LENGTH
            || (cfg!(target_os = "windows")
                && value.encode_utf16().count() * 2 > WINDOWS_CREDENTIAL_BLOB_BYTES)
        {
            return Err(AppError::Validation(
                "密码或私钥口令为空或超过系统凭据库限制".to_owned(),
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

    pub async fn get_private_key(
        &self,
        session_id: &str,
    ) -> CredentialResult<Option<Zeroizing<String>>> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::GetPrivateKey {
                session_id: session_id.to_owned(),
                response,
            })
            .map_err(|_| credential_error("读取私钥"))?;
        receiver.await.map_err(|_| credential_error("读取私钥"))?
    }

    pub async fn set_private_key(
        &self,
        session_id: &str,
        value: Zeroizing<String>,
    ) -> CredentialResult<()> {
        validate_private_key_material(&value)?;
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::SetPrivateKey {
                session_id: session_id.to_owned(),
                value,
                response,
            })
            .map_err(|_| credential_error("保存私钥"))?;
        receiver.await.map_err(|_| credential_error("保存私钥"))?
    }

    pub async fn private_key_is_complete(&self, session_id: &str) -> CredentialResult<bool> {
        match self.get_private_key(session_id).await {
            Ok(value) => Ok(value.is_some()),
            Err(error) if is_damaged_private_key_error(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub async fn get_private_key_snapshot(
        &self,
        session_id: &str,
    ) -> CredentialResult<Option<Zeroizing<String>>> {
        match self.get_private_key(session_id).await {
            Ok(value) => Ok(value),
            Err(error) if is_damaged_private_key_error(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn delete_private_key(&self, session_id: &str) -> CredentialResult<()> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::DeletePrivateKey {
                session_id: session_id.to_owned(),
                response,
            })
            .map_err(|_| credential_error("删除私钥"))?;
        receiver.await.map_err(|_| credential_error("删除私钥"))?
    }

    pub async fn delete_all(&self, session_id: &str) -> CredentialResult<()> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(CredentialRequest::DeleteAll {
                session_id: session_id.to_owned(),
                response,
            })
            .map_err(|_| credential_error("删除会话凭据"))?;
        receiver
            .await
            .map_err(|_| credential_error("删除会话凭据"))?
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

    fn get_private_key(&self, session_id: &str) -> CredentialResult<Option<Zeroizing<String>>> {
        let Some(manifest_value) = self.get(&private_key_manifest_account(session_id))? else {
            return Ok(None);
        };
        let manifest = serde_json::from_str::<PrivateKeyManifest>(&manifest_value)
            .map_err(|_| damaged_private_key_error())?;
        validate_manifest(&manifest)?;

        let mut chunks = Vec::with_capacity(manifest.chunk_count);
        for index in 0..manifest.chunk_count {
            let Some(chunk) = self.get(&private_key_chunk_account(session_id, index))? else {
                return Err(damaged_private_key_error());
            };
            chunks.push(chunk);
        }
        reassemble_private_key(&manifest, &chunks).map(Some)
    }

    fn set_private_key(&self, session_id: &str, value: Zeroizing<String>) -> CredentialResult<()> {
        let previous = match self.get_private_key(session_id) {
            Ok(value) => value,
            Err(error) if is_damaged_private_key_error(&error) => {
                // 损坏的旧分块无法作为回滚快照，先彻底清理，使用户可通过重新粘贴完成修复。
                self.delete_private_key(session_id)?;
                None
            }
            Err(error) => return Err(error),
        };
        if let Err(error) = self.write_private_key(session_id, &value) {
            let restored = match previous {
                Some(previous) => self.write_private_key(session_id, &previous),
                None => self.delete_private_key(session_id),
            };
            if restored.is_err() {
                return Err(AppError::Credential(
                    "系统凭据库保存私钥失败，且旧私钥恢复失败".to_owned(),
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    fn write_private_key(&self, session_id: &str, value: &str) -> CredentialResult<()> {
        let chunks = split_private_key(value)?;
        let manifest = PrivateKeyManifest::new(value, chunks.len());

        // 先写分块、最后写清单。读取方不会看到一份指向未完成分块的新清单。
        for (index, chunk) in chunks.iter().enumerate() {
            self.set(&private_key_chunk_account(session_id, index), chunk.clone())?;
        }
        let manifest_value = serde_json::to_string(&manifest)
            .map_err(|_| AppError::Credential("无法生成私钥凭据清单".to_owned()))?;
        self.set(
            &private_key_manifest_account(session_id),
            Zeroizing::new(manifest_value),
        )?;
        for index in chunks.len()..MAX_PRIVATE_KEY_CHUNKS {
            self.delete(&private_key_chunk_account(session_id, index))?;
        }

        match self.get_private_key(session_id)? {
            Some(saved) if saved.as_str() == value => Ok(()),
            _ => Err(AppError::Credential(
                "系统凭据库保存私钥校验失败".to_owned(),
            )),
        }
    }

    fn delete_private_key(&self, session_id: &str) -> CredentialResult<()> {
        self.delete(&private_key_manifest_account(session_id))?;
        for index in 0..MAX_PRIVATE_KEY_CHUNKS {
            self.delete(&private_key_chunk_account(session_id, index))?;
        }
        Ok(())
    }

    fn delete_all(&self, session_id: &str) -> CredentialResult<()> {
        self.delete(&credential_account(session_id))?;
        self.delete_private_key(session_id)
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
            CredentialRequest::GetPrivateKey {
                session_id,
                response,
            } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.get_private_key(&session_id));
                let _ = response.send(result);
            }
            CredentialRequest::SetPrivateKey {
                session_id,
                value,
                response,
            } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.set_private_key(&session_id, value));
                let _ = response.send(result);
            }
            CredentialRequest::DeletePrivateKey {
                session_id,
                response,
            } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.delete_private_key(&session_id));
                let _ = response.send(result);
            }
            CredentialRequest::DeleteAll {
                session_id,
                response,
            } => {
                let result = backend
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|backend| backend.delete_all(&session_id));
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

fn private_key_manifest_account(session_id: &str) -> String {
    format!("session:{session_id}:private-key")
}

fn private_key_chunk_account(session_id: &str, index: usize) -> String {
    format!("session:{session_id}:private-key:{index}")
}

impl PrivateKeyManifest {
    fn new(value: &str, chunk_count: usize) -> Self {
        Self {
            version: PRIVATE_KEY_MANIFEST_VERSION,
            chunk_count,
            byte_length: value.len(),
            checksum: private_key_checksum(value),
        }
    }
}

fn validate_private_key_material(value: &str) -> CredentialResult<()> {
    if value.is_empty() || value.len() > MAX_INLINE_PRIVATE_KEY_BYTES {
        return Err(AppError::Validation(
            "粘贴私钥不能为空，且不能超过 16384 字节".to_owned(),
        ));
    }
    Ok(())
}

fn split_private_key(value: &str) -> CredentialResult<Vec<Zeroizing<String>>> {
    validate_private_key_material(value)?;
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut chunk_bytes = 0;
    for character in value.chars() {
        let character_bytes = character.len_utf16() * 2;
        if chunk_bytes + character_bytes > PRIVATE_KEY_CHUNK_UTF16_BYTES && !chunk.is_empty() {
            chunks.push(Zeroizing::new(std::mem::take(&mut chunk)));
            chunk_bytes = 0;
        }
        chunk.push(character);
        chunk_bytes += character_bytes;
    }
    if !chunk.is_empty() {
        chunks.push(Zeroizing::new(chunk));
    }
    if chunks.is_empty() || chunks.len() > MAX_PRIVATE_KEY_CHUNKS {
        return Err(AppError::Validation("粘贴私钥分块数量超限".to_owned()));
    }
    Ok(chunks)
}

fn validate_manifest(manifest: &PrivateKeyManifest) -> CredentialResult<()> {
    if manifest.version != PRIVATE_KEY_MANIFEST_VERSION
        || manifest.chunk_count == 0
        || manifest.chunk_count > MAX_PRIVATE_KEY_CHUNKS
        || manifest.byte_length == 0
        || manifest.byte_length > MAX_INLINE_PRIVATE_KEY_BYTES
    {
        return Err(damaged_private_key_error());
    }
    Ok(())
}

fn reassemble_private_key(
    manifest: &PrivateKeyManifest,
    chunks: &[Zeroizing<String>],
) -> CredentialResult<Zeroizing<String>> {
    if chunks.len() != manifest.chunk_count {
        return Err(damaged_private_key_error());
    }
    let mut value = Zeroizing::new(String::with_capacity(manifest.byte_length));
    for chunk in chunks {
        if chunk.encode_utf16().count() * 2 > PRIVATE_KEY_CHUNK_UTF16_BYTES {
            return Err(damaged_private_key_error());
        }
        value.push_str(chunk);
    }
    if value.len() != manifest.byte_length || private_key_checksum(&value) != manifest.checksum {
        return Err(damaged_private_key_error());
    }
    Ok(value)
}

// 该校验仅用于发现凭据库分块损坏，不承担密码学认证职责。
fn private_key_checksum(value: &str) -> String {
    let mut checksum = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        checksum ^= u64::from(*byte);
        checksum = checksum.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{checksum:016x}")
}

fn damaged_private_key_error() -> AppError {
    AppError::Credential(DAMAGED_PRIVATE_KEY_MESSAGE.to_owned())
}

fn is_damaged_private_key_error(error: &AppError) -> bool {
    matches!(error, AppError::Credential(message) if message == DAMAGED_PRIVATE_KEY_MESSAGE)
}

fn credential_error(action: &str) -> AppError {
    AppError::Credential(format!("系统凭据库{action}失败"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_key_chunks_stay_within_windows_limit() {
        let value = "a".repeat(MAX_INLINE_PRIVATE_KEY_BYTES);
        let chunks = split_private_key(&value).expect("私钥应能正确分块");
        assert_eq!(chunks.len(), MAX_PRIVATE_KEY_CHUNKS);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.encode_utf16().count() * 2 <= PRIVATE_KEY_CHUNK_UTF16_BYTES));
    }

    #[test]
    fn private_key_manifest_detects_corruption() {
        let value = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n";
        let chunks = split_private_key(value).expect("私钥应能正确分块");
        let manifest = PrivateKeyManifest::new(value, chunks.len());
        assert_eq!(
            reassemble_private_key(&manifest, &chunks)
                .expect("私钥应能重新组装")
                .as_str(),
            value
        );

        let mut damaged = chunks;
        damaged[0].push('x');
        assert!(reassemble_private_key(&manifest, &damaged).is_err());
    }

    #[test]
    fn private_key_rejects_oversized_material() {
        let value = "a".repeat(MAX_INLINE_PRIVATE_KEY_BYTES + 1);
        assert!(split_private_key(&value).is_err());
    }
}
