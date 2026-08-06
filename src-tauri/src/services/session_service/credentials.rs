use crate::models::{
    AppError, CredentialState, PrivateKeySource, SessionAuth, SessionProfile, StoredSession,
};
use crate::services::CredentialService;
use zeroize::Zeroizing;

pub(super) enum SecretChange {
    Preserve,
    Set(Zeroizing<String>),
    Delete,
}

pub(super) struct AuthChanges {
    pub(super) credential: SecretChange,
    pub(super) private_key: SecretChange,
}

pub(super) struct SecretSnapshot {
    pub(super) credential: Option<Zeroizing<String>>,
    pub(super) private_key: Option<Zeroizing<String>>,
}

impl AuthChanges {
    pub(super) fn changed(&self) -> bool {
        !matches!(self.credential, SecretChange::Preserve)
            || !matches!(self.private_key, SecretChange::Preserve)
    }
}

pub(super) async fn apply_auth_changes(
    session_id: &str,
    changes: &AuthChanges,
    snapshot: &SecretSnapshot,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    let result = async {
        apply_private_key_change(session_id, &changes.private_key, credentials).await?;
        apply_credential_change(session_id, &changes.credential, credentials).await
    }
    .await;
    if let Err(error) = result {
        restore_secrets(session_id, snapshot, credentials)
            .await
            .map_err(|_| {
                AppError::Credential(
                    "系统凭据更新失败，且旧凭据回滚失败，请重新检查凭据".to_owned(),
                )
            })?;
        return Err(error);
    }
    Ok(())
}

async fn apply_credential_change(
    session_id: &str,
    change: &SecretChange,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match change {
        SecretChange::Preserve => Ok(()),
        SecretChange::Set(value) => credentials.set(session_id, value.clone()).await,
        SecretChange::Delete => credentials.delete(session_id).await,
    }
}

async fn apply_private_key_change(
    session_id: &str,
    change: &SecretChange,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    match change {
        SecretChange::Preserve => Ok(()),
        SecretChange::Set(value) => credentials.set_private_key(session_id, value.clone()).await,
        SecretChange::Delete => credentials.delete_private_key(session_id).await,
    }
}

pub(super) async fn snapshot_secrets(
    session_id: &str,
    changes: &AuthChanges,
    credentials: &CredentialService,
) -> Result<SecretSnapshot, AppError> {
    let private_key = if matches!(changes.private_key, SecretChange::Preserve) {
        credentials.get_private_key(session_id).await?
    } else {
        // 替换或删除时允许清除已损坏分块；其他凭据库错误仍必须阻止更新。
        credentials.get_private_key_snapshot(session_id).await?
    };
    Ok(SecretSnapshot {
        credential: credentials.get(session_id).await?,
        private_key,
    })
}

pub(super) async fn restore_secrets(
    session_id: &str,
    snapshot: &SecretSnapshot,
    credentials: &CredentialService,
) -> Result<(), AppError> {
    let private_key_result = match &snapshot.private_key {
        Some(value) => credentials.set_private_key(session_id, value.clone()).await,
        None => credentials.delete_private_key(session_id).await,
    };
    let credential_result = match &snapshot.credential {
        Some(value) => credentials.set(session_id, value.clone()).await,
        None => credentials.delete(session_id).await,
    };
    private_key_result.and(credential_result)
}

pub(super) async fn resolve_credential_state(
    session: &StoredSession,
    credentials: &CredentialService,
) -> Result<CredentialState, AppError> {
    match &session.auth {
        SessionAuth::Password => Ok(if credentials.get(&session.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        }),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::File,
            passphrase_required: false,
            ..
        } => Ok(CredentialState::NotRequired),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::File,
            passphrase_required: true,
            ..
        } => Ok(if credentials.get(&session.id).await?.is_some() {
            CredentialState::Stored
        } else {
            CredentialState::Missing
        }),
        SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            passphrase_required,
            ..
        } => {
            let has_private_key = credentials.private_key_is_complete(&session.id).await?;
            let has_passphrase =
                !passphrase_required || credentials.get(&session.id).await?.is_some();
            Ok(if has_private_key && has_passphrase {
                CredentialState::Stored
            } else {
                CredentialState::Missing
            })
        }
    }
}

pub(super) fn profile_with_state(
    stored: StoredSession,
    credential_state: CredentialState,
) -> SessionProfile {
    let mut profile = SessionProfile::from(stored);
    profile.credential_state = credential_state;
    profile
}
