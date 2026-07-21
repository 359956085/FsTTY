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
    AuthenticationInterrupted(String),
    AuthenticationRejected(String),
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
            | AppError::AuthenticationInterrupted(message)
            | AppError::AuthenticationRejected(message)
            | AppError::Connection(message)
            | AppError::Sftp(message)
            | AppError::Conflict(message)
            | AppError::Busy(message)
            | AppError::Internal(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_authentication_error_kinds() {
        let interrupted = serde_json::to_value(AppError::AuthenticationInterrupted(
            "SSH 认证连接中断".to_owned(),
        ))
        .expect("认证中断错误应能序列化");
        assert_eq!(interrupted["kind"], "authenticationInterrupted");

        let rejected = serde_json::to_value(AppError::AuthenticationRejected(
            "服务器拒绝 SSH 认证".to_owned(),
        ))
        .expect("认证拒绝错误应能序列化");
        assert_eq!(rejected["kind"], "authenticationRejected");
    }
}
