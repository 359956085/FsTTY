use super::*;

impl ConnectionManager {
    pub async fn write_terminal(&self, connection_id: &str, data: String) -> Result<(), AppError> {
        if data.is_empty() || data.len() > MAX_TERMINAL_INPUT_BYTES {
            return Err(AppError::Validation("终端输入大小无效".to_owned()));
        }
        let entry = self.entry(connection_id).await?;
        entry
            .terminal_tx
            .as_ref()
            .ok_or_else(|| AppError::Connection("当前连接没有终端".to_owned()))?
            .send(TerminalControl::Data(data.into_bytes()))
            .await
            .map_err(|_| AppError::Connection("终端连接已关闭".to_owned()))
    }

    pub async fn resize_terminal(
        &self,
        connection_id: &str,
        columns: u32,
        rows: u32,
    ) -> Result<(), AppError> {
        validate_terminal_size(columns, rows)?;
        let entry = self.entry(connection_id).await?;
        entry
            .terminal_tx
            .as_ref()
            .ok_or_else(|| AppError::Connection("当前连接没有终端".to_owned()))?
            .send(TerminalControl::Resize { columns, rows })
            .await
            .map_err(|_| AppError::Connection("终端连接已关闭".to_owned()))
    }

    pub async fn disconnect(&self, connection_id: &str) -> Result<(), AppError> {
        let Some(entry) = self.take_connection(connection_id).await else {
            return Ok(());
        };
        self.cancel_connection_transfers(connection_id).await;
        if let Some(terminal_tx) = &entry.terminal_tx {
            let _ = terminal_tx.send(TerminalControl::Close).await;
        }
        let handle = entry.handle.lock().await;
        let _ = handle
            .disconnect(Disconnect::ByApplication, "", "zh-CN")
            .await;
        Ok(())
    }

    pub async fn disconnect_session(&self, session_id: &str) {
        let cancellations = self
            .inner
            .connecting_sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        for cancellation in cancellations {
            cancellation.cancel();
        }
        let connection_ids = self
            .inner
            .session_connections
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        for connection_id in connection_ids {
            let _ = self.disconnect(&connection_id).await;
        }
    }

    pub async fn exec(
        &self,
        connection_id: &str,
        command: &'static str,
    ) -> Result<Vec<u8>, AppError> {
        let entry = self.entry(connection_id).await?;
        let mut channel = {
            let handle = entry.handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|_| AppError::Connection("无法创建设备信息通道".to_owned()))?
        };
        channel
            .exec(true, command)
            .await
            .map_err(|_| AppError::Connection("无法执行设备信息命令".to_owned()))?;
        let collect = async {
            let mut output = Vec::new();
            let mut exit_code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if output.len() + data.len() > MAX_EXEC_OUTPUT_BYTES {
                            return Err(AppError::Connection("设备信息输出过大".to_owned()));
                        }
                        output.extend_from_slice(&data);
                    }
                    ChannelMsg::ExitStatus { exit_status } => {
                        exit_code = Some(exit_status);
                        break;
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            if exit_code.is_some_and(|code| code != 0) {
                return Err(AppError::Connection("设备信息命令执行失败".to_owned()));
            }
            Ok(output)
        };
        time::timeout(EXEC_TIMEOUT, collect)
            .await
            .map_err(|_| AppError::Connection("设备信息命令超时".to_owned()))?
    }

    pub(super) async fn detect_login_shell(&self, connection_id: &str) -> Option<ShellName> {
        // 独立 exec 通道不会进入交互 Shell 历史；失败只关闭受控集成，不影响 SSH 连接。
        let output = time::timeout(
            Duration::from_secs(2),
            self.exec(connection_id, "printf '%s' \"${SHELL:-}\""),
        )
        .await
        .ok()?
        .ok()?;
        parse_shell_name(&output)
    }

    pub async fn exec_command(
        &self,
        connection_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<CommandOutput, AppError> {
        let entry = self.entry(connection_id).await?;
        let mut channel = {
            let handle = entry.handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|_| AppError::Connection("无法创建命令通道".to_owned()))?
        };
        channel
            .exec(true, command)
            .await
            .map_err(|_| AppError::Connection("无法执行远程命令".to_owned()))?;
        let collect = async {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut exit_code = None;
            let mut truncated = false;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => append_limited(
                        &mut stdout,
                        data.as_ref(),
                        MAX_MCP_EXEC_OUTPUT_BYTES,
                        &mut truncated,
                    ),
                    ChannelMsg::ExtendedData { data, .. } => append_limited(
                        &mut stderr,
                        data.as_ref(),
                        MAX_MCP_EXEC_OUTPUT_BYTES.saturating_sub(stdout.len()),
                        &mut truncated,
                    ),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok(CommandOutput {
                stdout,
                stderr,
                exit_code,
                truncated,
            })
        };
        time::timeout(timeout, collect)
            .await
            .map_err(|_| AppError::Connection("远程命令执行超时".to_owned()))?
    }
}

pub(super) fn parse_shell_name(output: &[u8]) -> Option<ShellName> {
    let value = std::str::from_utf8(output).ok()?.trim().replace('\\', "/");
    match value.rsplit('/').next()?.to_ascii_lowercase().as_str() {
        "bash" => Some(ShellName::Bash),
        "zsh" => Some(ShellName::Zsh),
        _ => None,
    }
}

pub(super) fn validate_terminal_size(columns: u32, rows: u32) -> Result<(), AppError> {
    if !(1..=1000).contains(&columns) || !(1..=1000).contains(&rows) {
        return Err(AppError::Validation("终端行列数无效".to_owned()));
    }
    Ok(())
}

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
