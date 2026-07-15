use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionAuth {
    Password,
    PrivateKey {
        path: String,
        passphrase_required: bool,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionAuthInput {
    Password,
    PrivateKey { path: String },
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
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum CredentialAction {
    Preserve,
    Replace { value: Zeroizing<String> },
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
    pub fn requires_credential(&self) -> bool {
        matches!(
            self.auth,
            SessionAuth::Password
                | SessionAuth::PrivateKey {
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
