use crate::models::AppError;
use keyring::v1::{Entry, Error as KeyringError};
use tokio::task;
use zeroize::Zeroizing;

const CREDENTIAL_SERVICE: &str = "com.fengshi.fstty";
const MAX_CREDENTIAL_LENGTH: usize = 16 * 1024;

#[derive(Clone, Default)]
pub struct CredentialService;

impl CredentialService {
    pub async fn get(&self, session_id: &str) -> Result<Option<Zeroizing<String>>, AppError> {
        let account = credential_account(session_id);
        task::spawn_blocking(move || {
            let entry =
                Entry::new(CREDENTIAL_SERVICE, &account).map_err(|_| credential_error("初始化"))?;
            match entry.get_password() {
                Ok(value) => Ok(Some(Zeroizing::new(value))),
                Err(KeyringError::NoEntry) => Ok(None),
                Err(_) => Err(credential_error("读取")),
            }
        })
        .await
        .map_err(|_| credential_error("读取"))?
    }

    pub async fn set(&self, session_id: &str, value: Zeroizing<String>) -> Result<(), AppError> {
        if value.is_empty() || value.len() > MAX_CREDENTIAL_LENGTH {
            return Err(AppError::Validation(
                "密码或私钥口令不能为空，且不能超过 16384 字节".to_owned(),
            ));
        }

        let account = credential_account(session_id);
        task::spawn_blocking(move || {
            let entry =
                Entry::new(CREDENTIAL_SERVICE, &account).map_err(|_| credential_error("初始化"))?;
            entry
                .set_password(&value)
                .map_err(|_| credential_error("保存"))
        })
        .await
        .map_err(|_| credential_error("保存"))?
    }

    pub async fn delete(&self, session_id: &str) -> Result<(), AppError> {
        let account = credential_account(session_id);
        task::spawn_blocking(move || {
            let entry =
                Entry::new(CREDENTIAL_SERVICE, &account).map_err(|_| credential_error("初始化"))?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(_) => Err(credential_error("删除")),
            }
        })
        .await
        .map_err(|_| credential_error("删除"))?
    }
}

fn credential_account(session_id: &str) -> String {
    format!("session:{session_id}")
}

fn credential_error(action: &str) -> AppError {
    AppError::Credential(format!("系统凭据库{action}失败"))
}
