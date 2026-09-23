use crate::{
    protocol::*,
    proxy,
    store::{change_id, Store},
    windows,
};
use std::{
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use windows_sys::Win32::System::Services::*;

static STOP: AtomicBool = AtomicBool::new(false);

pub fn dispatch() -> crate::Result<()> {
    let name = windows::wide(SERVICE);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_ptr().cast_mut(),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: null_mut(),
            lpServiceProc: None,
        },
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        return Err("必须由 Windows 服务管理器启动凭据服务".into());
    }
    Ok(())
}
unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::Release);
    }
    0
}
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let name = windows::wide(SERVICE);
    let handle = RegisterServiceCtrlHandlerExW(name.as_ptr(), Some(control), null());
    if handle.is_null() {
        return;
    }
    set_status(handle, SERVICE_START_PENDING, 0);
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "无法启动服务运行时".to_owned())
        .and_then(|runtime| runtime.block_on(run(|| set_status(handle, SERVICE_RUNNING, 0))));
    set_status(handle, SERVICE_STOPPED, if result.is_ok() { 0 } else { 1 });
}
fn set_status(handle: SERVICE_STATUS_HANDLE, state: u32, error: u32) {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: error,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: if state == SERVICE_START_PENDING {
            10000
        } else {
            0
        },
    };
    unsafe {
        SetServiceStatus(handle, &status);
    }
}

async fn run(ready: impl FnOnce()) -> crate::Result<()> {
    let identity = windows::current_identity()?;
    if !identity.sid.starts_with("S-1-5-80-") {
        return Err("服务必须以独立虚拟账号运行".into());
    }
    windows::protect_process()?;
    let dir = windows::data_dir()?;
    crate::paths::verify_tree(&dir, &identity.sid, true)?;
    let marker = dir.join("initialized.v1");
    let database = dir.join("credentials.v1.db");
    if marker.exists() && !database.exists() {
        return Err("托管凭据数据库缺失，拒绝创建空库或回退旧凭据".into());
    }
    let store = Arc::new(Mutex::new(Store::open(
        &database,
        Box::new(windows::Dpapi),
    )?));
    if !marker.exists() {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .map_err(|_| "无法记录服务初始化状态")?;
        file.write_all(b"1\n")
            .map_err(|_| "无法记录服务初始化状态")?;
        file.sync_all().map_err(|_| "无法提交服务初始化状态")?;
    }
    let config = proxy::server_config()?;
    let mut next = windows::listener(true)?;
    let mut clients = tokio::task::JoinSet::new();
    ready();
    loop {
        tokio::select! {
            connected=next.connect()=> {
                connected.map_err(|_|"服务管道监听失败")?;
                let pipe=next;next=windows::listener(false)?;
                while clients.try_join_next().is_some() {}
                if clients.len()>=64{drop(pipe);continue;}
                let store=store.clone();let config=config.clone();
                clients.spawn(async move {let _=serve(pipe,store,config).await;});
            }
            _=tokio::time::sleep(Duration::from_millis(250))=> {if STOP.load(Ordering::Acquire){break;}}
        }
    }
    clients.abort_all();
    while clients.join_next().await.is_some() {}
    Ok(())
}

async fn serve(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    store: Arc<Mutex<Store>>,
    config: Arc<russh::server::Config>,
) -> crate::Result<()> {
    let request: Request = tokio::time::timeout(Duration::from_secs(10), read(&mut pipe))
        .await
        .map_err(|_| "管道请求超时")??;
    let peer = windows::peer(&pipe)?;
    if let Request::BeginUpdate { size, signature } = request {
        let result = crate::update::receive(&mut pipe, &peer.sid, size, signature).await;
        if let Err(message) = result {
            return write(&mut pipe, &Response::Error { message }).await;
        }
        return Ok(());
    }
    if let Request::Connect { id, proxy: route } = &request {
        let loaded = store
            .lock()
            .map_err(|_| "服务存储不可用")?
            .load(&peer.sid, id)?;
        let Some((profile, secrets)) = loaded else {
            return write(
                &mut pipe,
                &Response::Error {
                    message: "会话尚未托管或已删除，请在 FsTTY 中迁移或配置凭据".into(),
                },
            )
            .await;
        };
        let revision = profile.revision;
        let invalidated = async {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if store
                    .lock()
                    .ok()
                    .and_then(|db| db.revision(&peer.sid, id).ok())
                    != Some(revision)
                {
                    break;
                }
            }
        };
        tokio::pin!(invalidated);
        let authenticated = tokio::select! {
            result=proxy::authenticate(&profile,secrets,route)=>result,
            _=&mut invalidated=>return Err("认证配置已变更，连接已取消".into()),
            _=tokio::io::AsyncReadExt::read_u8(&mut pipe)=>return Err("客户端已退出或连接协议无效".into()),
        };
        match authenticated {
            Ok(remote) => {
                if write(&mut pipe, &Response::Connected).await.is_err() {
                    let _ = remote
                        .disconnect(russh::Disconnect::ByApplication, "", "")
                        .await;
                    return Err("客户端已退出".into());
                }
                return proxy::serve_until(pipe, remote, config, invalidated).await;
            }
            Err(message) => return write(&mut pipe, &Response::Error { message }).await,
        }
    }
    let response = match process(request, &peer, store).await {
        Ok(response) => response,
        Err(message) => Response::Error { message },
    };
    write(&mut pipe, &response).await
}

async fn process(
    request: Request,
    peer: &windows::Identity,
    store: Arc<Mutex<Store>>,
) -> crate::Result<Response> {
    if let Request::Review { ticket } = &request {
        if !peer.elevated {
            return Err("查看审批需要管理员权限".into());
        }
        let tickets = store.lock().map_err(|_| "服务存储不可用")?.tickets(ticket);
        let mut reviews = Vec::new();
        for item in &tickets {
            reviews.push(review(item, &store).await?);
        }
        return if tickets.len() == 1 && tickets[0] == *ticket {
            Ok(Response::Review {
                review: Box::new(reviews.remove(0)),
            })
        } else {
            Ok(Response::BatchReview { reviews })
        };
    }
    if let Request::ReleaseUpdate { ticket } = &request {
        crate::update::release_for_owner(&peer.sid, ticket).await?;
        return Ok(Response::Complete);
    }
    let mut db = store.lock().map_err(|_| "服务存储不可用")?;
    match request {
        Request::Status => Ok(Response::Ready { version: VERSION }),
        Request::List => Ok(Response::Profiles {
            profiles: db.list(&peer.sid)?,
        }),
        Request::Batch { tickets } => Ok(Response::Staged {
            ticket: db.batch(&peer.sid, tickets)?,
        }),
        Request::Stage { change, proxy } => Ok(Response::Staged {
            ticket: db.stage_with_proxy(&peer.sid, change, None, proxy)?,
        }),
        Request::StageImport {
            target,
            secrets,
            proxy,
        } => Ok(Response::Staged {
            ticket: db.stage_with_proxy(
                &peer.sid,
                Change::Configure {
                    target,
                    replace_secret: true,
                },
                Some(secrets),
                proxy,
            )?,
        }),
        Request::Approve { ticket, secrets } => {
            db.approve(&ticket, peer.elevated, secrets)?;
            Ok(Response::Complete)
        }
        Request::Cancel { ticket } => {
            db.cancel(&peer.sid, &ticket);
            Ok(Response::Complete)
        }
        Request::CleanupComplete { id, revision } => {
            db.cleanup_complete(&peer.sid, &id, revision)?;
            Ok(Response::Complete)
        }
        _ => Err("服务操作无效".into()),
    }
}

async fn review(ticket: &str, store: &Arc<Mutex<Store>>) -> crate::Result<Review> {
    let (mut review, target, route) = {
        let db = store.lock().map_err(|_| "服务存储不可用")?;
        let p = db.pending(ticket)?;
        let old = db.load(&p.owner, change_id(&p.change))?;
        let needs_secret = matches!(
            &p.change,
            Change::Configure {
                replace_secret: true,
                ..
            }
        ) && p.imported.is_none();
        (
            Review {
                target: old.as_ref().map(|r| r.0.target.clone()),
                owner_sid: p.owner.clone(),
                change: p.change.clone(),
                revision: p.revision,
                old_fingerprint: old
                    .as_ref()
                    .map(|r| proxy::fingerprint(&r.0.host_key))
                    .unwrap_or_default(),
                fingerprint: String::new(),
                needs_secret,
                import: p.imported.is_some(),
            },
            if matches!(p.change, Change::Delete { .. }) {
                None
            } else {
                Some(db.target(ticket)?)
            },
            p.proxy.clone(),
        )
    };
    if let Some(target) = target {
        let key = proxy::probe(&target, &route).await?;
        review.target = Some(target);
        review.fingerprint = proxy::fingerprint(&key);
        store
            .lock()
            .map_err(|_| "服务存储不可用")?
            .set_observed_key(ticket, key)?;
    }
    Ok(review)
}
