use fstty_network::ProxySnapshot;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

pub async fn tunnel(
    target_port: u16,
    socks: bool,
) -> (ProxySnapshot, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            counter.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                if socks {
                    let mut greeting = [0; 3];
                    stream.read_exact(&mut greeting).await.unwrap();
                    assert_eq!(greeting, [5, 1, 0]);
                    stream.write_all(&[5, 0]).await.unwrap();
                    let mut header = [0; 4];
                    stream.read_exact(&mut header).await.unwrap();
                    assert_eq!(header, [5, 1, 0, 1]);
                    let mut ip = [0; 4];
                    stream.read_exact(&mut ip).await.unwrap();
                    assert_eq!(ip, [127, 0, 0, 1]);
                    assert_eq!(stream.read_u16().await.unwrap(), target_port);
                    stream
                        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
                        .await
                        .unwrap();
                } else {
                    let mut headers = Vec::new();
                    while !headers.ends_with(b"\r\n\r\n") {
                        headers.push(stream.read_u8().await.unwrap());
                        assert!(headers.len() < 16384);
                    }
                    assert!(String::from_utf8(headers)
                        .unwrap()
                        .starts_with(&format!("CONNECT 127.0.0.1:{target_port} HTTP/1.1")));
                    stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
                }
                let mut remote = TcpStream::connect(("127.0.0.1", target_port))
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
            });
        }
    });
    let scheme = if socks { "socks5" } else { "http" };
    (
        ProxySnapshot(format!("{scheme}://127.0.0.1:{port}")),
        count,
        task,
    )
}
