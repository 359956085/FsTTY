use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    Validation(String),
    NotFound(String),
    Internal(String),
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Validation(message)
            | AppError::NotFound(message)
            | AppError::Internal(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for AppError {}
