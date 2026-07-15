use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    Validation(String),
    NotFound(String),
    Persistence(String),
    Credential(String),
    Authentication(String),
    Connection(String),
    Sftp(String),
    Conflict(String),
    Busy(String),
    Internal(String),
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Validation(message)
            | AppError::NotFound(message)
            | AppError::Persistence(message)
            | AppError::Credential(message)
            | AppError::Authentication(message)
            | AppError::Connection(message)
            | AppError::Sftp(message)
            | AppError::Conflict(message)
            | AppError::Busy(message)
            | AppError::Internal(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for AppError {}
