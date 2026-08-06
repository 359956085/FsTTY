use super::{AuthenticationOutcome, AUTH_TIMEOUT, MAX_PRIVATE_KEY_BYTES};
use crate::models::{AppError, CredentialKind, PrivateKeySource, SessionAuth, StoredSession};
use crate::services::CredentialService;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{
    decode_secret_key,
    known_hosts::{check_known_hosts_path, known_host_keys_path},
    load_secret_key,
    ssh_key::{HashAlg, PublicKey},
    PrivateKeyWithHashAlg,
};
use russh::MethodKind;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};
use tokio::time;
use zeroize::Zeroizing;

#[derive(Clone, Debug)]
pub(super) enum HostObservation {
    Unknown(PublicKey),
    Changed {
        old_key: PublicKey,
        new_key: PublicKey,
    },
    Failure,
}

pub(super) struct SshClient {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) known_hosts_path: PathBuf,
    pub(super) known_hosts_lock: Arc<StdMutex<()>>,
    pub(super) observation: Arc<StdMutex<Option<HostObservation>>>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let _known_hosts_guard = match self.known_hosts_lock.lock() {
            Ok(guard) => guard,
            Err(_) => {
                set_observation(&self.observation, HostObservation::Failure);
                return Err(russh::Error::UnknownKey);
            }
        };
        match check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        ) {
            Ok(true) => Ok(true),
            Ok(false) => {
                set_observation(
                    &self.observation,
                    HostObservation::Unknown(server_public_key.clone()),
                );
                Ok(false)
            }
            Err(russh::keys::Error::KeyChanged { .. }) => {
                match known_host_keys_path(&self.host, self.port, &self.known_hosts_path) {
                    Ok(keys) => {
                        let keys = keys.into_iter().map(|(_, key)| key).collect::<Vec<_>>();
                        let old_key = keys
                            .iter()
                            .find(|key| key.algorithm() == server_public_key.algorithm())
                            .or_else(|| keys.first())
                            .cloned();
                        if let Some(old_key) = old_key {
                            set_observation(
                                &self.observation,
                                HostObservation::Changed {
                                    old_key,
                                    new_key: server_public_key.clone(),
                                },
                            );
                        } else {
                            set_observation(&self.observation, HostObservation::Failure);
                        }
                    }
                    Err(_) => set_observation(&self.observation, HostObservation::Failure),
                }
                Ok(false)
            }
            Err(_) => {
                set_observation(&self.observation, HostObservation::Failure);
                Err(russh::Error::UnknownKey)
            }
        }
    }
}

fn set_observation(observation: &StdMutex<Option<HostObservation>>, value: HostObservation) {
    if let Ok(mut observation) = observation.lock() {
        *observation = Some(value);
    }
}

pub(super) fn key_algorithm(key: &PublicKey) -> String {
    key.algorithm().as_str().to_owned()
}

pub(super) fn key_fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub(super) fn remove_known_host(path: &Path, host: &str, port: u16) -> Result<bool, AppError> {
    if !path.exists() {
        return Ok(false);
    }
    let target = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    let content = fs::read_to_string(path)
        .map_err(|_| AppError::Persistence("无法读取主机密钥文件".to_owned()))?;
    let mut removed = false;
    let retained = content
        .lines()
        .filter(|line| {
            let host_field = line.split_whitespace().next().unwrap_or_default();
            let matched = !line.starts_with('#')
                && host_field.split(',').any(|candidate| candidate == target);
            removed |= matched;
            !matched
        })
        .collect::<Vec<_>>()
        .join("\n");
    if removed {
        let temp = path.with_extension("tmp");
        fs::write(&temp, format!("{retained}\n"))
            .map_err(|_| AppError::Persistence("无法写入主机密钥临时文件".to_owned()))?;
        fs::remove_file(path)
            .map_err(|_| AppError::Persistence("无法替换主机密钥文件".to_owned()))?;
        fs::rename(temp, path)
            .map_err(|_| AppError::Persistence("无法提交主机密钥文件".to_owned()))?;
    }
    Ok(removed)
}

pub(super) async fn authenticate(
    handle: &mut client::Handle<SshClient>,
    session: &StoredSession,
    credentials: &CredentialService,
    one_time_credential: Option<Zeroizing<String>>,
) -> Result<AuthenticationOutcome, AppError> {
    time::timeout(
        AUTH_TIMEOUT,
        authenticate_inner(handle, session, credentials, one_time_credential),
    )
    .await
    .map_err(|_| AppError::Authentication("SSH 认证超时".to_owned()))?
}

async fn authenticate_inner(
    handle: &mut client::Handle<SshClient>,
    session: &StoredSession,
    credentials: &CredentialService,
    one_time_credential: Option<Zeroizing<String>>,
) -> Result<AuthenticationOutcome, AppError> {
    // OpenSSH 客户端会先用 none 查询可用方法。部分受限服务端依赖该顺序，直接提交密码会被拒绝。
    let remaining_methods = match handle
        .authenticate_none(session.username.clone())
        .await
        .map_err(|error| map_authentication_exchange_error(error, "无法查询 SSH 认证方式"))?
    {
        client::AuthResult::Success => return Ok(AuthenticationOutcome::Authenticated),
        client::AuthResult::Failure {
            remaining_methods,
            partial_success,
        } => {
            if partial_success {
                return Err(AppError::Authentication(
                    "SSH 需要继续认证，当前版本不支持多因素认证".to_owned(),
                ));
            }
            remaining_methods
        }
    };

    let expected_method = match &session.auth {
        SessionAuth::Password => {
            if remaining_methods.contains(&MethodKind::Password) {
                MethodKind::Password
            } else if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                MethodKind::KeyboardInteractive
            } else {
                return Err(authentication_method_unavailable(MethodKind::Password));
            }
        }
        SessionAuth::PrivateKey { .. } => {
            if !remaining_methods.contains(&MethodKind::PublicKey) {
                return Err(authentication_method_unavailable(MethodKind::PublicKey));
            }
            MethodKind::PublicKey
        }
    };

    let result = match &session.auth {
        SessionAuth::Password => {
            let secret = match one_time_credential {
                Some(value) => value,
                None => match credentials.get(&session.id).await? {
                    Some(value) => value,
                    None => {
                        return Ok(AuthenticationOutcome::CredentialRequired(
                            CredentialKind::Password,
                        ))
                    }
                },
            };
            if expected_method == MethodKind::KeyboardInteractive {
                let mut response = handle
                    .authenticate_keyboard_interactive_start(&session.username, None::<String>)
                    .await
                    .map_err(|error| {
                        map_authentication_exchange_error(error, "SSH 交互认证失败")
                    })?;
                let mut prompt_rounds = 0_u8;
                loop {
                    response = match response {
                        KeyboardInteractiveAuthResponse::Success => {
                            break client::AuthResult::Success;
                        }
                        KeyboardInteractiveAuthResponse::Failure {
                            partial_success: true,
                            ..
                        } => {
                            return Err(AppError::Authentication(
                                "SSH 需要继续认证，当前版本不支持多因素认证".to_owned(),
                            ))
                        }
                        KeyboardInteractiveAuthResponse::Failure { .. } => {
                            return Err(authentication_rejected(expected_method))
                        }
                        KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                            if prompt_rounds > 0 {
                                return Err(AppError::Authentication(
                                    "SSH 需要连续交互认证，当前版本不支持多因素认证".to_owned(),
                                ));
                            }
                            prompt_rounds += 1;
                            let responses = prompts
                                .into_iter()
                                .map(|prompt| {
                                    if prompt.echo {
                                        session.username.clone()
                                    } else {
                                        secret.as_str().to_owned()
                                    }
                                })
                                .collect();
                            handle
                                .authenticate_keyboard_interactive_respond(responses)
                                .await
                                .map_err(|error| {
                                    map_authentication_exchange_error(error, "SSH 交互认证失败")
                                })?
                        }
                    };
                }
            } else {
                handle
                    .authenticate_password(session.username.clone(), secret.as_str().to_owned())
                    .await
                    .map_err(|error| map_authentication_exchange_error(error, "SSH 密码认证失败"))?
            }
        }
        SessionAuth::PrivateKey {
            source,
            path,
            passphrase_required,
        } => {
            if *source == PrivateKeySource::File {
                let key_path = path
                    .as_deref()
                    .ok_or_else(|| AppError::Persistence("私钥文件路径缺失".to_owned()))?;
                let metadata = tokio::fs::metadata(key_path)
                    .await
                    .map_err(|_| AppError::Credential("私钥文件不存在或无法读取".to_owned()))?;
                if !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
                    return Err(AppError::Credential(
                        "私钥文件必须是小于 1 MiB 的普通文件".to_owned(),
                    ));
                }
            }
            let inline_key = if *source == PrivateKeySource::Inline {
                Some(
                    credentials
                        .get_private_key(&session.id)
                        .await?
                        .ok_or_else(|| {
                            AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                        })?,
                )
            } else {
                None
            };
            let passphrase = if *passphrase_required {
                match one_time_credential {
                    Some(value) => Some(value),
                    None => match credentials.get(&session.id).await? {
                        Some(value) => Some(value),
                        None => {
                            return Ok(AuthenticationOutcome::CredentialRequired(
                                CredentialKind::PrivateKeyPassphrase,
                            ))
                        }
                    },
                }
            } else {
                None
            };
            let key = match source {
                PrivateKeySource::File => {
                    let key_path = path
                        .clone()
                        .ok_or_else(|| AppError::Persistence("私钥文件路径缺失".to_owned()))?;
                    tokio::task::spawn_blocking(move || {
                        load_secret_key(key_path, passphrase.as_ref().map(|value| value.as_str()))
                    })
                    .await
                    .map_err(|_| AppError::Credential("私钥加载任务失败".to_owned()))?
                    .map_err(|_| AppError::Credential("无法加载私钥或口令错误".to_owned()))?
                }
                PrivateKeySource::Inline => {
                    let inline_key = inline_key.ok_or_else(|| {
                        AppError::Credential("已保存私钥缺失，请重新粘贴".to_owned())
                    })?;
                    tokio::task::spawn_blocking(move || {
                        decode_secret_key(
                            &inline_key,
                            passphrase.as_ref().map(|value| value.as_str()),
                        )
                    })
                    .await
                    .map_err(|_| AppError::Credential("私钥加载任务失败".to_owned()))?
                    .map_err(|_| AppError::Credential("无法加载私钥或口令错误".to_owned()))?
                }
            };
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| map_authentication_exchange_error(error, "无法协商私钥算法"))?
                .flatten();
            handle
                .authenticate_publickey(
                    session.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| map_authentication_exchange_error(error, "SSH 私钥认证失败"))?
        }
    };

    match result {
        client::AuthResult::Success => Ok(AuthenticationOutcome::Authenticated),
        client::AuthResult::Failure {
            partial_success: true,
            ..
        } => Err(AppError::Authentication(
            "SSH 需要继续认证，当前版本不支持多因素认证".to_owned(),
        )),
        client::AuthResult::Failure { .. } => Err(authentication_rejected(expected_method)),
    }
}

pub(super) fn map_authentication_exchange_error(error: russh::Error, fallback: &str) -> AppError {
    if is_authentication_interruption(&error) {
        AppError::AuthenticationInterrupted("SSH 认证连接中断，请重试".to_owned())
    } else {
        AppError::Authentication(fallback.to_owned())
    }
}

pub(super) fn is_authentication_interruption(error: &russh::Error) -> bool {
    match error {
        russh::Error::HUP
        | russh::Error::Disconnect
        | russh::Error::SendError
        | russh::Error::RecvError => true,
        russh::Error::IO(error) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof
                | std::io::ErrorKind::NotConnected
        ),
        _ => false,
    }
}

pub(super) fn authentication_rejected(method: MethodKind) -> AppError {
    let message = match method {
        MethodKind::Password | MethodKind::KeyboardInteractive => "服务器拒绝密码认证",
        MethodKind::PublicKey => "服务器拒绝私钥认证",
        _ => "服务器拒绝 SSH 认证",
    };
    AppError::AuthenticationRejected(message.to_owned())
}

fn authentication_method_unavailable(method: MethodKind) -> AppError {
    let message = match method {
        MethodKind::Password | MethodKind::KeyboardInteractive => "服务器未启用密码认证",
        MethodKind::PublicKey => "服务器未启用私钥认证",
        _ => "服务器未启用所选认证方式",
    };
    AppError::Authentication(message.to_owned())
}
