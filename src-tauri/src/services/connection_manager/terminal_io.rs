use super::*;

pub(super) async fn wait_for_channel_success(
    channel: &mut russh::Channel<client::Msg>,
    action: &str,
    pending: &mut PendingTerminalMessages,
) -> Result<(), AppError> {
    // 请求回执可能晚于远端首屏输出；先暂存，避免 Shell 已启动但欢迎信息被静默丢弃。
    time::timeout(TERMINAL_REQUEST_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => {
                    return Err(AppError::Connection(format!("服务器拒绝{action}")));
                }
                Some(ChannelMsg::Close) | None => {
                    return Err(AppError::Connection(format!("{action}时终端通道已关闭")));
                }
                Some(message) => pending.push(message)?,
            }
        }
    })
    .await
    .map_err(|_| AppError::Connection(format!("等待服务器{action}超时")))?
}

pub(super) async fn run_terminal(
    connection_id: String,
    terminal_reader: russh::ChannelReadHalf,
    terminal_writer: russh::ChannelWriteHalf<client::Msg>,
    controls: mpsc::Receiver<TerminalControl>,
    events: Channel<TerminalEvent>,
    pending: VecDeque<ChannelMsg>,
) {
    // 拆开读写半通道：写入受远端窗口阻塞时，读取仍会持续推进并释放窗口。
    let reader = run_terminal_reader(
        connection_id.clone(),
        terminal_reader,
        events.clone(),
        pending,
    );
    let writer = run_terminal_writer(terminal_writer, controls);
    tokio::pin!(reader);
    tokio::pin!(writer);
    let end = tokio::select! {
        end = &mut reader => end,
        end = &mut writer => end,
    };
    match end {
        TerminalEnd::Disconnected { exit_code, message } => {
            let _ = events.send(TerminalEvent::Disconnected {
                connection_id,
                exit_code,
                message,
            });
        }
        TerminalEnd::Error(message) => {
            let _ = events.send(TerminalEvent::Error {
                connection_id,
                message,
            });
        }
        TerminalEnd::ClientGone => {}
    }
}

async fn run_terminal_reader(
    connection_id: String,
    mut terminal: russh::ChannelReadHalf,
    events: Channel<TerminalEvent>,
    mut pending: VecDeque<ChannelMsg>,
) -> TerminalEnd {
    let mut output_batch = TerminalOutputBatch::new();
    let mut flush_deadline = None;
    loop {
        let message = match flush_deadline {
            Some(deadline) => {
                tokio::select! {
                    biased;
                    _ = time::sleep_until(deadline) => {
                        if flush_terminal_output(&connection_id, &events, &mut output_batch).is_err() {
                            return TerminalEnd::ClientGone;
                        }
                        flush_deadline = None;
                        continue;
                    }
                    message = next_terminal_message(&mut terminal, &mut pending) => message,
                }
            }
            None => next_terminal_message(&mut terminal, &mut pending).await,
        };
        match message {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                let mut remaining = data.as_ref();
                while !remaining.is_empty() {
                    if output_batch.is_empty() {
                        flush_deadline = Some(time::Instant::now() + TERMINAL_OUTPUT_BATCH_DELAY);
                    }
                    let appended = output_batch.append(remaining);
                    remaining = &remaining[appended..];
                    if output_batch.is_full() {
                        if flush_terminal_output(&connection_id, &events, &mut output_batch)
                            .is_err()
                        {
                            return TerminalEnd::ClientGone;
                        }
                        flush_deadline = None;
                    }
                }
            }
            message => {
                // 断线和退出事件必须排在最后一批输出之后，避免终端尾部内容丢失。
                if flush_terminal_output(&connection_id, &events, &mut output_batch).is_err() {
                    return TerminalEnd::ClientGone;
                }
                flush_deadline = None;
                match message {
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        return TerminalEnd::Disconnected {
                            exit_code: Some(exit_status),
                            message: format!("远程 Shell 已退出，状态码 {exit_status}"),
                        };
                    }
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        return TerminalEnd::Disconnected {
                            exit_code: None,
                            message: "远程 Shell 因信号退出".to_owned(),
                        };
                    }
                    Some(ChannelMsg::Eof) => {
                        return TerminalEnd::Disconnected {
                            exit_code: None,
                            message: "远程 Shell 已关闭输出".to_owned(),
                        };
                    }
                    Some(ChannelMsg::Failure) => {
                        return TerminalEnd::Error("远程终端请求失败".to_owned());
                    }
                    Some(ChannelMsg::Close) | None => {
                        return TerminalEnd::Disconnected {
                            exit_code: None,
                            message: "连接已断开".to_owned(),
                        };
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn next_terminal_message(
    terminal: &mut russh::ChannelReadHalf,
    pending: &mut VecDeque<ChannelMsg>,
) -> Option<ChannelMsg> {
    match pending.pop_front() {
        Some(message) => Some(message),
        None => terminal.wait().await,
    }
}

fn flush_terminal_output(
    connection_id: &str,
    events: &Channel<TerminalEvent>,
    output_batch: &mut TerminalOutputBatch,
) -> Result<(), ()> {
    if output_batch.is_empty() {
        return Ok(());
    }
    let result = events.send(TerminalEvent::Data {
        connection_id: connection_id.to_owned(),
        data: BASE64_STANDARD.encode(output_batch.as_slice()),
    });
    output_batch.clear();
    result.map_err(|_| ())
}

async fn run_terminal_writer(
    terminal: russh::ChannelWriteHalf<client::Msg>,
    mut controls: mpsc::Receiver<TerminalControl>,
) -> TerminalEnd {
    while let Some(control) = controls.recv().await {
        match control {
            TerminalControl::Data(data) => {
                if terminal.data_bytes(data).await.is_err() {
                    return TerminalEnd::Error("终端输入发送失败".to_owned());
                }
            }
            TerminalControl::Resize { columns, rows } => {
                if terminal.window_change(columns, rows, 0, 0).await.is_err() {
                    return TerminalEnd::Error("终端尺寸同步失败".to_owned());
                }
            }
            TerminalControl::Close => {
                let _ = terminal.close().await;
                return TerminalEnd::Disconnected {
                    exit_code: None,
                    message: "连接已断开".to_owned(),
                };
            }
        }
    }
    let _ = terminal.close().await;
    TerminalEnd::Disconnected {
        exit_code: None,
        message: "连接已断开".to_owned(),
    }
}
