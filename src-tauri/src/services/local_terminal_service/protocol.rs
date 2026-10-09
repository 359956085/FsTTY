use crate::models::LocalShell;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{self, Read, Write};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_INPUT: usize = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Startup {
    pub shell: LocalShell,
    pub directory: String,
    pub columns: u32,
    pub rows: u32,
    pub elevated: bool,
    #[serde(default)]
    pub highlight_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Request {
    Start(Startup),
    Input { data: Vec<u8> },
    Resize { columns: u32, rows: u32 },
    Stop {},
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Response {
    Hello {
        nonce: String,
    },
    Ready {
        elevated: bool,
        label: String,
        #[serde(default)]
        highlight: Option<crate::models::LocalHighlightInfo>,
    },
    Data {
        data: Vec<u8>,
    },
    Exit {
        code: Option<u32>,
    },
    Error {
        message: String,
    },
}

pub fn dimensions(columns: u32, rows: u32) -> bool {
    (1..=1000).contains(&columns) && (1..=1000).contains(&rows)
}

fn frame<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_FRAME {
        return Err(io::Error::other("本地终端消息过大"));
    }
    let mut bytes = Vec::with_capacity(body.len() + 4);
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    Ok(bytes)
}

fn length(header: [u8; 4]) -> io::Result<usize> {
    let size = u32::from_le_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(io::Error::other("本地终端消息长度无效"));
    }
    Ok(size)
}

pub fn read<T: DeserializeOwned>(pipe: &mut impl Read) -> io::Result<T> {
    let mut header = [0; 4];
    pipe.read_exact(&mut header)?;
    let mut body = vec![0; length(header)?];
    pipe.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}
pub fn write(pipe: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    pipe.write_all(&frame(value)?)
}
pub async fn receive<T: DeserializeOwned>(pipe: &mut (impl AsyncRead + Unpin)) -> io::Result<T> {
    let mut header = [0; 4];
    pipe.read_exact(&mut header).await?;
    let mut body = vec![0; length(header)?];
    pipe.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}
pub async fn send(pipe: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> io::Result<()> {
    pipe.write_all(&frame(value)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_truncated_and_unknown_messages() {
        assert!(read::<Request>(&mut &((MAX_FRAME + 1) as u32).to_le_bytes()[..]).is_err());
        assert!(read::<Request>(&mut &[1, 0, 0, 0][..]).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"kind":"Stop","command":"oops"}"#).is_err());
        assert!(!dimensions(0, 24));
        assert!(!dimensions(80, 1001));
    }
    #[test]
    fn binary_input_round_trips_without_shell_interpretation() {
        let mut bytes = Vec::new();
        write(
            &mut bytes,
            &Request::Input {
                data: "中文\u{3}\r\n".as_bytes().to_vec(),
            },
        )
        .unwrap();
        let Request::Input { data } = read(&mut bytes.as_slice()).unwrap() else {
            panic!()
        };
        assert_eq!(data, "中文\u{3}\r\n".as_bytes());
    }
}
