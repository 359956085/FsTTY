mod app_error;
mod clipboard;
mod command_history;
mod connection;
mod device;
mod file;
mod session;
mod settings;
mod update;

pub use app_error::AppError;
pub use clipboard::ClipboardContentKind;
pub use command_history::{
    CommandHistoryEntry, CommandHistoryImportResult, CommandHistoryPage, CommandHistorySettings,
};
pub use connection::{
    ConnectResult, CredentialKind, HostKeyChallenge, HostKeyChange, SshConnection, TerminalEvent,
    TransferEvent,
};
pub use device::DeviceStatus;
pub use file::{FileEntry, FileKind};
pub use session::{
    CreateSessionPayload, CredentialAction, CredentialState, LoginSaveDecision,
    PrivateKeyMaterialAction, PrivateKeySource, SessionAuth, SessionAuthInput, SessionGroup,
    SessionProfile, StoredSession, UpdateSessionPayload,
};
pub use settings::{
    AppSettings, Language, McpCommandMatchType, McpCommandPolicy, McpCommandPolicyMode,
    McpCommandRule, McpGroupPermission, ShortcutBinding, ShortcutSettings,
};
pub use update::{AppUpdateInfo, AppUpdateProgress, AppUpdateSource};
