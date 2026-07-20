use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub connection_id: String,
    pub session_id: String,
    pub home_path: String,
    pub sftp_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectResult {
    Connected { connection: SshConnection },
    HostKeyRequired { challenge: HostKeyChallenge },
    HostKeyChanged { change: HostKeyChange },
    CredentialRequired { credential_kind: CredentialKind },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialKind {
    Password,
    PrivateKeyPassphrase,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChallenge {
    pub challenge_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChange {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub old_fingerprint: String,
    pub new_fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Data {
        connection_id: String,
        data: String,
    },
    Disconnected {
        connection_id: String,
        exit_code: Option<u32>,
        message: String,
    },
    Error {
        connection_id: String,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TransferEvent {
    Progress {
        transfer_id: String,
        transferred_bytes: u64,
        total_bytes: u64,
    },
    Completed {
        transfer_id: String,
        transferred_bytes: u64,
        total_bytes: u64,
    },
    Cancelled {
        transfer_id: String,
        transferred_bytes: u64,
        total_bytes: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_channel_event_fields_as_camel_case() {
        let terminal = serde_json::to_value(TerminalEvent::Data {
            connection_id: "connection".to_owned(),
            data: "data".to_owned(),
        })
        .expect("无法序列化终端事件");
        assert_eq!(terminal["connectionId"], "connection");
        assert!(terminal.get("connection_id").is_none());

        let transfer = serde_json::to_value(TransferEvent::Progress {
            transfer_id: "transfer".to_owned(),
            transferred_bytes: 1,
            total_bytes: 2,
        })
        .expect("无法序列化传输事件");
        assert_eq!(transfer["transferId"], "transfer");
        assert_eq!(transfer["transferredBytes"], 1);
        assert_eq!(transfer["totalBytes"], 2);
        assert!(transfer.get("transfer_id").is_none());
    }

    #[test]
    fn serializes_credential_required_result_as_camel_case() {
        let value = serde_json::to_value(ConnectResult::CredentialRequired {
            credential_kind: CredentialKind::PrivateKeyPassphrase,
        })
        .expect("凭据询问结果应能序列化");
        assert_eq!(value["kind"], "credentialRequired");
        assert_eq!(value["credentialKind"], "privateKeyPassphrase");
        assert!(value.get("credential_kind").is_none());
    }
}
