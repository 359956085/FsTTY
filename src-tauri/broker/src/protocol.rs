use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

pub const VERSION: u32 = 2;
pub const SERVICE: &str = "FsTTYBroker";
// 保持 IPC 地址稳定；消息协议拒绝旧服务，提示修复而不降级直连。
pub const PIPE: &str = r"\\.\pipe\FsTTYBroker-v1";
pub const MAX_FRAME: usize = 2 * 1024 * 1024;
pub const MAX_KEY: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key: bool,
}

impl Target {
    pub fn validate(&self) -> crate::Result<()> {
        uuid::Uuid::parse_str(&self.id).map_err(|_| "会话 ID 无效")?;
        if self.port == 0
            || self.host.is_empty()
            || self.host.len() > 253
            || self.username.trim().is_empty()
            || self.username.len() > 128
            || self
                .host
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
            || self.username.chars().any(char::is_control)
        {
            return Err("认证目标无效".into());
        }
        Ok(())
    }
}

// 秘密类型不实现 Debug，防止错误报告输出内容。
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Secrets {
    pub password: Zeroizing<String>,
    pub private_key: Zeroizing<String>,
}

impl Secrets {
    pub fn validate(&self) -> crate::Result<()> {
        if self.password.len() > 16384 || self.private_key.len() > MAX_KEY {
            Err("凭据超过大小限制".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Configure {
        target: Target,
        replace_secret: bool,
    },
    Delete {
        id: String,
    },
    Trust {
        id: String,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Status,
    BeginUpdate {
        size: u64,
        signature: String,
    },
    List,
    Connect {
        id: String,
        proxy: fstty_network::ProxySnapshot,
    },
    Stage {
        change: Change,
        proxy: fstty_network::ProxySnapshot,
    },
    Batch {
        tickets: Vec<String>,
    },
    Review {
        ticket: String,
    },
    Approve {
        ticket: String,
        secrets: Option<Secrets>,
    },
    Cancel {
        ticket: String,
    },
    // 迁移数据只进入服务暂存区，仍需管理工具明确批准。
    StageImport {
        target: Target,
        secrets: Secrets,
        proxy: fstty_network::ProxySnapshot,
    },
    CleanupComplete {
        id: String,
        revision: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub target: Target,
    pub revision: u64,
    pub host_key: String,
    pub cleanup_pending: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub target: Option<Target>,
    pub owner_sid: String,
    pub change: Change,
    pub revision: u64,
    pub old_fingerprint: String,
    pub fingerprint: String,
    pub needs_secret: bool,
    pub import: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Response {
    Ready { version: u32 },
    Profiles { profiles: Vec<Profile> },
    Staged { ticket: String },
    Review { review: Box<Review> },
    BatchReview { reviews: Vec<Review> },
    Complete,
    Connected,
    Error { message: String },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    version: u32,
    body: T,
}

pub async fn write<T: Serialize, W: AsyncWrite + Unpin>(
    stream: &mut W,
    body: &T,
) -> crate::Result<()> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(&Envelope {
            version: VERSION,
            body,
        })
        .map_err(|_| "无法编码服务请求")?,
    );
    if bytes.len() > MAX_FRAME {
        return Err("服务消息过大".into());
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|_| "服务连接已断开")?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| "服务连接已断开")?;
    stream.flush().await.map_err(|_| "服务连接已断开".into())
}

pub async fn read<T: DeserializeOwned, R: AsyncRead + Unpin>(stream: &mut R) -> crate::Result<T> {
    let length = stream.read_u32().await.map_err(|_| "服务连接已断开")? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("服务消息长度无效".into());
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| "服务消息不完整")?;
    #[derive(Deserialize)]
    struct VersionOnly {
        version: u32,
    }
    let version: VersionOnly = serde_json::from_slice(&bytes).map_err(|_| "服务消息格式无效")?;
    if version.version != VERSION {
        return Err("FsTTY 与凭据服务版本不兼容，请修复安装".into());
    }
    let envelope: Envelope<T> = serde_json::from_slice(&bytes).map_err(|_| "服务消息格式无效")?;
    Ok(envelope.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn 拒绝超大消息且无需分配声明的内存() {
        let (mut tx, mut rx) = tokio::io::duplex(16);
        tx.write_u32(u32::MAX).await.unwrap();
        assert!(read::<Request, _>(&mut rx).await.is_err());
    }
    #[test]
    fn 接口没有读取秘密或指定连接目标的入口() {
        for value in [
            r#"{"operation":"getSecret"}"#,
            r#"{"operation":"connect","id":"x","proxy":"","host":"evil"}"#,
        ] {
            assert!(serde_json::from_str::<Request>(value).is_err());
        }
    }
    #[tokio::test]
    async fn 版本不匹配拒绝执行() {
        for bytes in [
            br#"{"version":1,"body":{"operation":"status"}}"#.as_slice(),
            br#"{"version":1,"body":{"operation":"connect","id":"x"}}"#.as_slice(),
        ] {
            let (mut tx, mut rx) = tokio::io::duplex(1024);
            tx.write_u32(bytes.len() as u32).await.unwrap();
            tx.write_all(bytes).await.unwrap();
            assert!(read::<Request, _>(&mut rx)
                .await
                .err()
                .unwrap()
                .contains("版本"));
        }
    }
}
