//! Wire-level regression for RUSTSEC-2026-0492. All clear-text algorithms here
//! are confined to an in-memory test transport; production preferences are unchanged.
use russh::{client, server, Channel, ChannelId, ChannelMsg};
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::time::{timeout, Duration};

#[derive(Default, Debug, PartialEq)]
struct Events {
    data: Vec<Vec<u8>>,
    statuses: Vec<u32>,
    closes: usize,
}
struct Client(Arc<Mutex<Events>>);
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(matches!(
            key,
            russh::keys::PublicKeyOrCertificate::PublicKey { .. }
        ))
    }
    async fn data(
        &mut self,
        _: ChannelId,
        data: &[u8],
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.0.lock().unwrap().data.push(data.to_vec());
        Ok(())
    }
    async fn exit_status(
        &mut self,
        _: ChannelId,
        status: u32,
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.0.lock().unwrap().statuses.push(status);
        Ok(())
    }
    async fn channel_close(
        &mut self,
        _: ChannelId,
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.0.lock().unwrap().closes += 1;
        Ok(())
    }
}
struct Server(Vec<Channel<server::Msg>>);
impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.0.push(channel);
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"verified output".to_vec())?;
        session.exit_status_request(channel, 7)?;
        session.eof(channel)?;
        session.close(channel)
    }
}
fn clear_preferences() -> russh::Preferred {
    russh::Preferred {
        host_key_certificates: Cow::Borrowed(&[]),
        kex: Cow::Owned(vec![russh::kex::CURVE25519]),
        key: Cow::Owned(vec![russh::keys::Algorithm::Ed25519]),
        cipher: Cow::Owned(vec![russh::cipher::NONE]),
        mac: Cow::Owned(vec![russh::mac::NONE]),
        compression: Cow::Owned(vec![russh::compression::NONE]),
    }
}
fn packet(payload: &[u8]) -> Vec<u8> {
    let mut padding = 8 - (5 + payload.len()) % 8;
    if padding < 4 {
        padding += 8;
    }
    let mut result = ((payload.len() + padding + 1) as u32)
        .to_be_bytes()
        .to_vec();
    result.push(padding as u8);
    result.extend_from_slice(payload);
    result.resize(result.len() + padding, 0);
    result
}
async fn inject_before_confirmation(
    mut source: tokio::io::ReadHalf<DuplexStream>,
    mut destination: tokio::io::WriteHalf<DuplexStream>,
    injected: Arc<AtomicUsize>,
) {
    // Forward the identification line, then bounded RFC 4253 packets. No payload
    // is captured or logged; synthetic messages target pending and unknown IDs.
    loop {
        let byte = source.read_u8().await.unwrap();
        destination.write_u8(byte).await.unwrap();
        if byte == b'\n' {
            break;
        }
    }
    while let Ok(length) = source.read_u32().await {
        assert!((5..=262144).contains(&length));
        let mut body = vec![0; length as usize];
        source.read_exact(&mut body).await.unwrap();
        if body.get(1) == Some(&91) {
            let pending = u32::from_be_bytes(body[2..6].try_into().unwrap());
            for target in [pending, u32::MAX - 1] {
                let mut data = vec![94];
                data.extend_from_slice(&target.to_be_bytes());
                data.extend_from_slice(&6u32.to_be_bytes());
                data.extend_from_slice(b"forged");
                let mut status = vec![98];
                status.extend_from_slice(&target.to_be_bytes());
                status.extend_from_slice(&11u32.to_be_bytes());
                status.extend_from_slice(b"exit-status");
                status.push(0);
                status.extend_from_slice(&99u32.to_be_bytes());
                let mut close = vec![97];
                close.extend_from_slice(&target.to_be_bytes());
                for payload in [data, status, close] {
                    destination.write_all(&packet(&payload)).await.unwrap();
                    injected.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        if destination.write_all(&length.to_be_bytes()).await.is_err() {
            break;
        }
        if destination.write_all(&body).await.is_err() {
            break;
        }
    }
}
#[tokio::test]
async fn 未建立通道的伪造数据退出码和关闭消息不进入回调() {
    timeout(Duration::from_secs(10), async {
        let (client_stream, relay_client) = tokio::io::duplex(65536);
        let (relay_server, server_stream) = tokio::io::duplex(65536);
        let (mut client_read, client_write) = tokio::io::split(relay_client);
        let (server_read, mut server_write) = tokio::io::split(relay_server);
        let outbound = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut client_read, &mut server_write).await;
        });
        let injected = Arc::new(AtomicUsize::new(0));
        let inbound = tokio::spawn(inject_before_confirmation(
            server_read,
            client_write,
            injected.clone(),
        ));
        let mut server_config = fstty_broker::proxy::server_config().unwrap();
        Arc::get_mut(&mut server_config).unwrap().preferred = clear_preferences();
        let server_task = tokio::spawn(async move {
            let running = server::run_stream(server_config, server_stream, Server(vec![]))
                .await
                .unwrap();
            let _ = running.await;
        });
        let events = Arc::new(Mutex::new(Events::default()));
        let mut handle = client::connect_stream(
            Arc::new(client::Config {
                preferred: clear_preferences(),
                ..Default::default()
            }),
            client_stream,
            Client(events.clone()),
        )
        .await
        .unwrap();
        assert!(handle.authenticate_none("fixture").await.unwrap().success());
        let mut channel = handle.channel_open_session().await.unwrap();
        channel.exec(true, b"fixture".to_vec()).await.unwrap();
        let mut output = Vec::new();
        let mut statuses = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => statuses.push(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        assert_eq!(injected.load(Ordering::SeqCst), 6);
        assert_eq!(output, b"verified output");
        assert_eq!(statuses, vec![7]);
        assert_eq!(
            *events.lock().unwrap(),
            Events {
                data: vec![b"verified output".to_vec()],
                statuses: vec![7],
                closes: 1
            }
        );
        handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await
            .unwrap();
        server_task.abort();
        outbound.abort();
        inbound.abort();
    })
    .await
    .expect("伪造通道消息不得阻断合法通道");
}
