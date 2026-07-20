use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionAuth {
    Password,
    PrivateKey {
        #[serde(default)]
        source: PrivateKeySource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(alias = "passphrase_required")]
        passphrase_required: bool,
    },
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivateKeySource {
    // 旧会话没有 source 字段，必须继续按文件路径读取。
    #[default]
    File,
    Inline,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionAuthInput {
    Password,
    PrivateKey {
        source: PrivateKeySource,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        material: Option<PrivateKeyMaterialAction>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PrivateKeyMaterialAction {
    Preserve,
    Replace { value: Zeroizing<String> },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub tags: Vec<String>,
    pub auth: SessionAuth,
    pub credential_state: CredentialState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub tags: Vec<String>,
    pub auth: SessionAuth,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialState {
    Stored,
    Missing,
    NotRequired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub name: String,
    pub sessions: Vec<SessionProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CredentialAction {
    Preserve,
    Replace { value: Zeroizing<String> },
    UseOnce { value: Zeroizing<String> },
    Clear,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionPayload {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub auth: SessionAuthInput,
    pub credential: CredentialAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionPayload {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub auth: SessionAuthInput,
    pub credential: CredentialAction,
}

impl StoredSession {
    pub fn requires_passphrase(&self) -> bool {
        matches!(
            self.auth,
            SessionAuth::PrivateKey {
                passphrase_required: true,
                ..
            }
        )
    }
}

impl From<StoredSession> for SessionProfile {
    fn from(session: StoredSession) -> Self {
        Self {
            id: session.id,
            name: session.name,
            host: session.host,
            port: session.port,
            username: session.username,
            group: session.group,
            tags: session.tags,
            auth: session.auth,
            credential_state: CredentialState::Missing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_private_key_defaults_to_file_source() {
        let auth = serde_json::from_value::<SessionAuth>(serde_json::json!({
            "kind": "privateKey",
            "path": "C:\\keys\\id_ed25519",
            "passphrase_required": true
        }))
        .expect("旧私钥认证记录应保持兼容");
        assert_eq!(
            auth,
            SessionAuth::PrivateKey {
                source: PrivateKeySource::File,
                path: Some("C:\\keys\\id_ed25519".to_owned()),
                passphrase_required: true,
            }
        );
    }

    #[test]
    fn inline_private_key_profile_never_contains_material() {
        let auth = SessionAuth::PrivateKey {
            source: PrivateKeySource::Inline,
            path: None,
            passphrase_required: false,
        };
        let value = serde_json::to_value(auth).expect("内联私钥认证信息应能序列化");
        assert_eq!(value["source"], "inline");
        assert_eq!(value["passphraseRequired"], false);
        assert!(value.get("passphrase_required").is_none());
        assert!(value.get("path").is_none());
        assert!(value.get("material").is_none());
        assert!(value.get("value").is_none());
    }

    #[test]
    fn credential_action_accepts_one_time_secret() {
        let action = serde_json::from_value::<CredentialAction>(serde_json::json!({
            "mode": "useOnce",
            "value": "临时口令"
        }))
        .expect("一次性凭据应能反序列化");
        assert!(
            matches!(action, CredentialAction::UseOnce { value } if value.as_str() == "临时口令")
        );
    }
}
