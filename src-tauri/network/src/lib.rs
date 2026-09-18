use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{fmt, net::IpAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use tokio_rustls::{rustls, TlsConnector};
use url::Url;
use zeroize::Zeroizing;

pub const MAX_PROXY_BYTES: usize = 512;

// 代理快照只决定路由，不包含或改变 SSH 认证目标。
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProxySnapshot(pub String);

impl fmt::Debug for ProxySnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.0.trim().is_empty() {
            "ProxySnapshot(直连)"
        } else {
            "ProxySnapshot(已配置)"
        })
    }
}

pub fn parse_proxy(address: &str) -> Result<Option<Url>, String> {
    if address.len() > MAX_PROXY_BYTES || address.chars().any(char::is_control) {
        return Err("代理地址无效：最多 512 字节，不能包含控制字符".into());
    }
    let address = address.trim();
    if address.is_empty() {
        return Ok(None);
    }
    if !["http://", "https://", "socks5://"]
        .iter()
        .any(|prefix| address.starts_with(prefix))
        || address.contains('\\')
    {
        return Err("代理地址必须使用 HTTP、HTTPS 或 SOCKS5".into());
    }
    let url = Url::parse(address).map_err(|_| "代理地址格式无效")?;
    let host = url.host_str().ok_or("代理主机不能为空")?;
    let port = proxy_port(&url);
    if host.is_empty()
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
        || port == 0
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("代理主机、端口或地址格式无效".into());
    }
    let (username, password) = credentials(&url)?;
    if url.scheme() == "socks5" && (username.len() > 255 || password.len() > 255) {
        return Err("SOCKS5 代理认证信息过长".into());
    }
    Ok(Some(url))
}

fn proxy_port(url: &Url) -> u16 {
    url.port().unwrap_or(match url.scheme() {
        "https" => 443,
        "socks5" => 1080,
        _ => 80,
    })
}

fn credentials(url: &Url) -> Result<(Zeroizing<String>, Zeroizing<String>), String> {
    let decode = |value: &str| -> Result<Zeroizing<String>, String> {
        let decoded = percent_decode_str(value)
            .decode_utf8()
            .map_err(|_| "代理认证信息编码无效")?;
        if decoded.chars().any(char::is_control) {
            return Err("代理认证信息包含控制字符".into());
        }
        Ok(Zeroizing::new(decoded.into_owned()))
    };
    Ok((
        decode(url.username())?,
        decode(url.password().unwrap_or(""))?,
    ))
}

pub trait NetworkIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> NetworkIo for T {}
pub type NetworkStream = Box<dyn NetworkIo>;

pub async fn connect(
    host: &str,
    port: u16,
    proxy: &ProxySnapshot,
    timeout: Duration,
) -> Result<NetworkStream, String> {
    let url = parse_proxy(&proxy.0)?;
    if host.is_empty() || port == 0 || host.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("连接目标无效".into());
    }
    tokio::time::timeout(timeout, connect_inner(host, port, url, None))
        .await
        .map_err(|_| "网络连接或代理握手超时".to_owned())?
}

async fn connect_inner(
    host: &str,
    port: u16,
    url: Option<Url>,
    tls_override: Option<Arc<rustls::ClientConfig>>,
) -> Result<NetworkStream, String> {
    let Some(url) = url else {
        let stream = TcpStream::connect((host, port))
            .await
            .map_err(|_| "无法连接目标主机")?;
        stream.set_nodelay(true).map_err(|_| "无法配置连接")?;
        return Ok(Box::new(stream));
    };
    let proxy_host = url.host_str().ok_or("代理主机不能为空")?;
    // URL 的 IPv6 主机带方括号，TCP 和 TLS 使用不带括号的名称。
    let proxy_host = proxy_host.trim_start_matches('[').trim_end_matches(']');
    let tcp = TcpStream::connect((proxy_host, proxy_port(&url)))
        .await
        .map_err(|_| "无法连接代理服务器")?;
    tcp.set_nodelay(true).map_err(|_| "无法配置代理连接")?;
    let mut stream: NetworkStream = if url.scheme() == "https" {
        let config = match tls_override {
            Some(config) => config,
            None => native_tls_config()?,
        };
        let name = rustls::pki_types::ServerName::try_from(proxy_host.to_owned())
            .map_err(|_| "HTTPS 代理主机名无效")?;
        Box::new(
            TlsConnector::from(config)
                .connect(name, tcp)
                .await
                .map_err(|_| "HTTPS 代理 TLS 握手失败，请检查证书和主机名")?,
        )
    } else {
        Box::new(tcp)
    };
    if url.scheme() == "socks5" {
        socks_connect(&mut stream, host, port, &url).await?;
    } else {
        http_connect(&mut stream, host, port, &url).await?;
    }
    Ok(stream)
}

fn native_tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    let certs = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    for cert in certs.certs {
        roots.add(cert).map_err(|_| "无法加载代理证书信任库")?;
    }
    if roots.is_empty() {
        return Err("代理证书信任库为空".into());
    }
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| "无法配置代理 TLS")?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    ))
}

async fn http_connect(
    stream: &mut NetworkStream,
    host: &str,
    port: u16,
    url: &Url,
) -> Result<(), String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
    ));
    let (username, password) = credentials(url)?;
    if !username.is_empty() || !password.is_empty() {
        let clear = Zeroizing::new(format!("{}:{}", username.as_str(), password.as_str()));
        let encoded = Zeroizing::new(STANDARD.encode(clear.as_bytes()));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| "代理请求发送失败")?;
    // 逐字节读取至头部末尾，保留代理提前返回的 SSH 数据。
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 16 * 1024 {
            return Err("代理响应头超过限制".into());
        }
        response.push(stream.read_u8().await.map_err(|_| "代理响应不完整")?);
    }
    let line = response
        .split(|b| *b == b'\n')
        .next()
        .ok_or("代理响应无效")?;
    let line = std::str::from_utf8(line).map_err(|_| "代理响应无效")?;
    let mut parts = line.split_whitespace();
    if !matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
        return Err("代理响应协议无效".into());
    }
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("代理响应无效")?;
    match status {
        200..=299 => Ok(()),
        407 => Err("代理认证失败".into()),
        _ => Err(format!("代理拒绝隧道连接（HTTP {status}）")),
    }
}

async fn socks_connect(
    stream: &mut NetworkStream,
    host: &str,
    port: u16,
    url: &Url,
) -> Result<(), String> {
    let (username, password) = credentials(url)?;
    let method = if username.is_empty() && password.is_empty() {
        0
    } else {
        2
    };
    stream
        .write_all(&[5, 1, method])
        .await
        .map_err(|_| "SOCKS5 握手发送失败")?;
    let mut reply = [0; 2];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|_| "SOCKS5 握手响应不完整")?;
    if reply != [5, method] {
        return Err("SOCKS5 代理认证方式不匹配".into());
    }
    if method == 2 {
        let mut auth = Zeroizing::new(vec![1, username.len() as u8]);
        auth.extend_from_slice(username.as_bytes());
        auth.push(password.len() as u8);
        auth.extend_from_slice(password.as_bytes());
        stream
            .write_all(&auth)
            .await
            .map_err(|_| "SOCKS5 认证发送失败")?;
        stream
            .read_exact(&mut reply)
            .await
            .map_err(|_| "SOCKS5 认证响应不完整")?;
        if reply != [1, 0] {
            return Err("SOCKS5 代理认证失败".into());
        }
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.len() > 255 {
                return Err("SOCKS5 目标主机名过长".into());
            }
            request.extend_from_slice(&[3, host.len() as u8]);
            request.extend_from_slice(host.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|_| "SOCKS5 隧道请求发送失败")?;
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|_| "SOCKS5 隧道响应不完整")?;
    if header[0] != 5 || header[2] != 0 {
        return Err("SOCKS5 隧道响应无效".into());
    }
    if header[1] != 0 {
        return Err("SOCKS5 代理拒绝隧道连接".into());
    }
    let length = match header[3] {
        1 => 4,
        4 => 16,
        3 => stream.read_u8().await.map_err(|_| "SOCKS5 响应不完整")? as usize,
        _ => return Err("SOCKS5 响应地址无效".into()),
    };
    let mut bound = vec![0; length + 2];
    stream
        .read_exact(&mut bound)
        .await
        .map_err(|_| "SOCKS5 响应不完整")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn listener() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    async fn headers<R: AsyncRead + Unpin>(stream: &mut R) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
            assert!(bytes.len() < 16384);
        }
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn 校验三种代理主机端口大小和认证信息() {
        for valid in [
            "",
            "  ",
            "http://proxy",
            "https://proxy:443",
            "socks5://[::1]:1080",
            "http://user:p%40ss@localhost:7890",
        ] {
            assert!(parse_proxy(valid).is_ok(), "应接受有效代理");
        }
        for invalid in [
            "ftp://proxy:80",
            "http://",
            "http://proxy:0",
            "http://proxy:65536",
            "http://proxy:abc",
            "socks5://:1080",
            "http://proxy/path",
            "http://proxy?q=1",
            "http://proxy#fragment",
            "http://proxy\n",
            "http://user:%0a@proxy",
            "http:proxy",
        ] {
            assert!(parse_proxy(invalid).is_err(), "应拒绝无效代理");
        }
        assert!(parse_proxy(&format!("http://{}", "x".repeat(512))).is_err());
    }

    #[test]
    fn 调试输出不展示代理认证信息() {
        let proxy = ProxySnapshot("http://secret-user:secret-password@proxy:80".into());
        let debug = format!("{proxy:?}");
        assert!(!debug.contains("secret"));
        assert_eq!(
            serde_json::from_str::<ProxySnapshot>(&serde_json::to_string(&proxy).unwrap()).unwrap(),
            proxy
        );
    }

    #[tokio::test]
    async fn 空地址明确直连并传输数据() {
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"direct").await.unwrap();
        });
        let mut stream = connect(
            "127.0.0.1",
            port,
            &Default::default(),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        let mut data = [0; 6];
        stream.read_exact(&mut data).await.unwrap();
        assert_eq!(&data, b"direct");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http隧道支持认证并保留头部之后的ssh数据() {
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = headers(&mut stream).await;
            assert!(request.starts_with("CONNECT server.invalid:22 HTTP/1.1\r\n"));
            assert!(request.contains(&format!(
                "Proxy-Authorization: Basic {}",
                STANDARD.encode("user:p@ss")
            )));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\n\r\nSSH")
                .await
                .unwrap();
        });
        let proxy = ProxySnapshot(format!("http://user:p%40ss@127.0.0.1:{port}"));
        let mut stream = connect("server.invalid", 22, &proxy, Duration::from_secs(2))
            .await
            .unwrap();
        let mut banner = [0; 3];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn 代理认证失败不泄露秘密且不直连回退() {
        let (destination, target_port) = listener().await;
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = headers(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 407 Denied\r\n\r\n")
                .await
                .unwrap();
        });
        let proxy = ProxySnapshot(format!("http://secret-user:secret-pass@127.0.0.1:{port}"));
        let error = connect("127.0.0.1", target_port, &proxy, Duration::from_secs(2))
            .await
            .err()
            .unwrap();
        assert!(error.contains("认证失败"));
        assert!(!error.contains("secret"));
        assert!(
            tokio::time::timeout(Duration::from_millis(40), destination.accept())
                .await
                .is_err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn 代理握手超时不尝试直连() {
        let (destination, target_port) = listener().await;
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let proxy = ProxySnapshot(format!("http://127.0.0.1:{port}"));
        let error = connect("127.0.0.1", target_port, &proxy, Duration::from_millis(50))
            .await
            .err()
            .unwrap();
        assert!(error.contains("超时"));
        assert!(
            tokio::time::timeout(Duration::from_millis(40), destination.accept())
                .await
                .is_err()
        );
        server.abort();
    }

    #[tokio::test]
    async fn socks5认证隧道将域名交给代理解析() {
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 1, 2]);
            stream.write_all(&[5, 2]).await.unwrap();
            assert_eq!(stream.read_u8().await.unwrap(), 1);
            let len = stream.read_u8().await.unwrap();
            let mut username = vec![0; len as usize];
            stream.read_exact(&mut username).await.unwrap();
            let len = stream.read_u8().await.unwrap();
            let mut password = vec![0; len as usize];
            stream.read_exact(&mut password).await.unwrap();
            assert_eq!(username, b"user");
            assert_eq!(password, b"pass");
            stream.write_all(&[1, 0]).await.unwrap();
            let mut request = [0; 4];
            stream.read_exact(&mut request).await.unwrap();
            assert_eq!(request, [5, 1, 0, 3]);
            let len = stream.read_u8().await.unwrap();
            let mut host = vec![0; len as usize];
            stream.read_exact(&mut host).await.unwrap();
            assert_eq!(host, b"server.invalid");
            assert_eq!(stream.read_u16().await.unwrap(), 22);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22])
                .await
                .unwrap();
            stream.write_all(b"SSH").await.unwrap();
        });
        let mut stream = connect(
            "server.invalid",
            22,
            &ProxySnapshot(format!("socks5://user:pass@127.0.0.1:{port}")),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        let mut banner = [0; 3];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn socks5认证失败不回退且错误脱敏() {
        let (listener, port) = listener().await;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 3];
            stream.read_exact(&mut greeting).await.unwrap();
            stream.write_all(&[5, 255]).await.unwrap();
        });
        let error = connect(
            "server.invalid",
            22,
            &ProxySnapshot(format!("socks5://secret-user:secret-pass@127.0.0.1:{port}")),
            Duration::from_secs(2),
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("认证"));
        assert!(!error.contains("secret"));
        server.await.unwrap();
    }

    fn tls_configs() -> (Arc<rustls::ServerConfig>, Arc<rustls::ClientConfig>) {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let cert = certified.cert.der().clone();
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
        let server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key.into())
        .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert).unwrap();
        let client = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        (Arc::new(server), Arc::new(client))
    }

    #[tokio::test]
    async fn https代理校验证书后使用connect隧道() {
        let (listener, port) = listener().await;
        let (server_config, client_config) = tls_configs();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut stream = tokio_rustls::TlsAcceptor::from(server_config)
                .accept(tcp)
                .await
                .unwrap();
            assert!(headers(&mut stream)
                .await
                .starts_with("CONNECT server.invalid:22 "));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\n\r\nSSH")
                .await
                .unwrap();
        });
        let mut stream = connect_inner(
            "server.invalid",
            22,
            parse_proxy(&format!("https://localhost:{port}")).unwrap(),
            Some(client_config),
        )
        .await
        .unwrap();
        let mut banner = [0; 3];
        stream.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https代理拒绝不受信证书及错误主机名() {
        for wrong_host in [false, true] {
            let (listener, port) = listener().await;
            let (server_config, client_config) = tls_configs();
            let server = tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let _ = tokio_rustls::TlsAcceptor::from(server_config)
                    .accept(tcp)
                    .await;
            });
            let host = if wrong_host { "127.0.0.1" } else { "localhost" };
            let proxy = parse_proxy(&format!("https://{host}:{port}")).unwrap();
            let error = connect_inner(
                "server.invalid",
                22,
                proxy,
                wrong_host.then_some(client_config),
            )
            .await
            .err()
            .unwrap();
            assert!(error.contains("证书") || error.contains("TLS"));
            server.await.unwrap();
        }
    }
}
