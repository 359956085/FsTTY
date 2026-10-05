use super::SessionProfile;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalShell {
    Cmd,
    Powershell,
    GitBash,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSession {
    pub id: String,
    pub name: String,
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub shell: LocalShell,
    pub starting_directory: String,
    pub run_as_admin: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSessionPayload {
    pub id: Option<String>,
    pub name: String,
    pub group: String,
    pub shell: LocalShell,
    pub starting_directory: String,
    pub run_as_admin: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceSession {
    Ssh(SessionProfile),
    Local(LocalSession),
}

#[derive(Debug, Serialize)]
pub struct WorkspaceSessionGroup {
    pub name: String,
    pub sessions: Vec<WorkspaceSession>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalInfo {
    pub shell: LocalShell,
    pub label: String,
    pub elevated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalShellAvailability {
    pub shell: LocalShell,
    pub available: bool,
    pub label: String,
    pub reason: Option<String>,
}
