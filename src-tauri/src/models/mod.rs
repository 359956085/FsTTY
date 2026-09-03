mod app_error;
mod clipboard;
mod command_history;
mod connection;
mod device;
mod file;
mod lightweight;
mod session;
mod settings;
mod transfer_job;
mod update;

pub use app_error::AppError;
pub use clipboard::ClipboardContentKind;
pub use command_history::{
    CommandHistoryEntry, CommandHistoryImportResult, CommandHistoryPage, CommandHistorySettings,
};
pub use connection::{
    ConnectResult, CredentialKind, HostKeyChallenge, HostKeyChange, ShellName, SshConnection,
    TerminalEvent, TransferEvent,
};
pub use device::{DeviceMetricSample, DeviceMetricsSnapshot, DeviceStatus};
pub use file::{FileEntry, FileKind};
pub use lightweight::{
    BeginLightweightModeResult, LightweightModePhase, LightweightModeState,
    LightweightSnapshotKind, LightweightTerminalRequest, PreservedTerminalAttachment,
    PreservedTerminalSummary, TerminalResumeEvent,
};
pub use session::{
    CreateSessionPayload, CredentialAction, CredentialState, LoginSaveDecision,
    PrivateKeyMaterialAction, PrivateKeySource, SessionAuth, SessionAuthInput, SessionGroup,
    SessionProfile, StoredSession, UpdateSessionPayload,
};
pub use settings::{
    AppSettings, Language, McpCommandMatchType, McpCommandPolicy, McpCommandPolicyMode,
    McpCommandRule, McpGroupPermission, ShortcutBinding, ShortcutSettings, ThemePreference,
    UpdateSourcePreference,
};
pub use transfer_job::{
    StartTransferJobRequest, TransferConflictDecision, TransferJobDirection, TransferJobEvent,
    TransferJobState, TransferJobSummary,
};
pub use update::{AppUpdateInfo, AppUpdateProgress, AppUpdateSource};
