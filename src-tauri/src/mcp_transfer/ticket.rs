use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(super) struct TransferTicket {
    pub(super) session_id: String,
    pub(super) kind: TransferTicketKind,
    pub(super) expires_at: Instant,
    pub(super) state: TransferTicketState,
    pub(super) cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub(super) enum TransferTicketKind {
    Download {
        remote_path: String,
        file_name: String,
    },
    Upload {
        remote_directory: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TransferTicketState {
    Ready,
    Active,
}

pub(crate) struct IssuedTransferLink {
    pub url: String,
    pub expires_in_seconds: u64,
    pub expires_at_unix_ms: u128,
}
