use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

mod proxy_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/network/tests/support/mod.rs"
    ));
}

fn application() -> tauri::App<tauri::test::MockRuntime> {
    let mut context = mock_context(noop_assets());
    // 仅测试夹具使用本机 HTTP；生产更新源仍使用 HTTPS 与签名校验。
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": "test-only",
            "dangerousInsecureTransportProtocol": true
        }),
    );
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap()
}

async fn endpoint(
    download_url: Option<String>,
    proxy_only: bool,
) -> (u16, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let counter = counter.clone();
            let download_url = download_url
                .clone()
                .unwrap_or_else(|| format!("http://127.0.0.1:{port}/package"));
            tokio::spawn(async move {
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(stream.read_u8().await.unwrap());
                }
                let request = String::from_utf8(headers).unwrap();
                if proxy_only {
                    assert!(request.starts_with("GET http://"));
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let content = if request.lines().next().unwrap().contains("/package") {
                    "unsigned-test-package".to_owned()
                } else {
                    serde_json::json!({
                        "version": "9.9.9", "url": download_url, "signature": "invalid-test-signature"
                    }).to_string()
                };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}", content.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    (port, count, task)
}

#[tokio::test]
async fn 更新检查与下载使用新http代理且不关闭旧更新对象() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let app = application();
        let (first_port, first_count, first) =
            endpoint(Some("http://download.invalid/package".into()), true).await;
        let (next_port, next_count, next) =
            endpoint(Some("http://download.invalid/package".into()), true).await;
        let mut update = check_source(
            app.handle(),
            AppUpdateSource::GitHub,
            "http://manifest.invalid/check",
            parse_proxy(&format!("http://127.0.0.1:{first_port}")).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(first_count.load(Ordering::SeqCst), 1);
        let old = update.clone();
        apply_download_proxy(
            &mut update,
            parse_proxy(&format!("http://127.0.0.1:{next_port}")).unwrap(),
        );
        assert_ne!(old.proxy, update.proxy);
        let mut downloaded = 0;
        // 不安装未签名测试包；确认数据经过新代理后仍执行原有签名校验。
        assert!(update
            .download(|bytes, _| downloaded += bytes, || {})
            .await
            .is_err());
        assert!(downloaded > 0);
        assert_eq!(first_count.load(Ordering::SeqCst), 1);
        assert_eq!(next_count.load(Ordering::SeqCst), 1);
        first.abort();
        next.abort();
    })
    .await
    .expect("更新代理测试不能超时");
}

#[tokio::test]
async fn 更新检查与下载支持socks5并可从旧代理切换为明确直连() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let app = application();
        let (port, count, origin) = endpoint(None, false).await;
        let (route, proxy_count, tunnel) = proxy_fixture::tunnel(port, true).await;
        let mut update = check_source(
            app.handle(),
            AppUpdateSource::Cnb,
            &format!("http://127.0.0.1:{port}/check"),
            parse_proxy(&route.0).unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(proxy_count.load(Ordering::SeqCst), 1);
        let mut downloaded = 0;
        assert!(update
            .download(|bytes, _| downloaded += bytes, || {})
            .await
            .is_err());
        assert!(downloaded > 0);
        assert_eq!(proxy_count.load(Ordering::SeqCst), 2);
        apply_download_proxy(&mut update, None);
        assert!(update.no_proxy);
        assert!(update.proxy.is_none());
        assert!(update.download(|_, _| {}, || {}).await.is_err());
        assert_eq!(proxy_count.load(Ordering::SeqCst), 2);
        assert_eq!(count.load(Ordering::SeqCst), 3);
        origin.abort();
        tunnel.abort();
    })
    .await
    .expect("SOCKS5 更新测试不能超时");
}

#[tokio::test]
async fn 更新代理连接失败不绕过代理且错误不泄露认证信息() {
    let app = application();
    let (port, count, origin) = endpoint(None, false).await;
    let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed_port = unused.local_addr().unwrap().port();
    drop(unused);
    let error = check_source(
        app.handle(),
        AppUpdateSource::GitHub,
        &format!("http://127.0.0.1:{port}/check"),
        parse_proxy(&format!(
            "http://secret-user:secret-pass@127.0.0.1:{closed_port}"
        ))
        .unwrap(),
    )
    .await
    .err()
    .unwrap();
    assert!(!error.contains("secret"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    origin.abort();
}
