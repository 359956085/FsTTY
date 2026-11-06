#![allow(deprecated)] // Roots remains supported by both legacy and modern clients.

use super::LocalTransferArgs;
use rmcp::{model::*, service::RequestContext, ErrorData as McpError, RoleServer};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::Instant;
use uuid::Uuid;

const ROOTS_KEY: &str = "roots";
const ROOTS_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PENDING: usize = 128;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum LocalTransfer {
    Upload,
    Download,
}

#[derive(Clone, Default)]
pub(super) struct PendingRoots(Arc<Mutex<HashMap<String, RootsRequest>>>);

struct RootsRequest {
    transfer: LocalTransfer,
    args_hash: [u8; 32],
    expires_at: Instant,
}

impl PendingRoots {
    pub(super) fn begin(
        &self,
        transfer: LocalTransfer,
        args: &LocalTransferArgs,
    ) -> Option<InputRequiredResult> {
        let args_hash = hash_args(args);
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        pending.retain(|_, request| request.expires_at > now);
        if pending.len() >= MAX_PENDING {
            return None;
        }
        let key = Uuid::new_v4().to_string();
        pending.insert(
            key.clone(),
            RootsRequest {
                transfer,
                args_hash,
                expires_at: now + ROOTS_TIMEOUT,
            },
        );
        Some(InputRequiredResult::new(
            Some(InputRequests::from([(
                ROOTS_KEY.to_owned(),
                InputRequest::ListRoots(ListRootsRequest::default()),
            )])),
            Some(key),
        ))
    }

    pub(super) fn resume(
        &self,
        state: &str,
        transfer: LocalTransfer,
        args: &LocalTransferArgs,
    ) -> Result<(), McpError> {
        let args_hash = hash_args(args);
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        pending.retain(|_, request| request.expires_at > now);
        if pending
            .get(state)
            .is_some_and(|request| request.transfer == transfer && request.args_hash == args_hash)
        {
            pending.remove(state);
            return Ok(());
        }
        Err(McpError::invalid_params(
            "Roots request state is invalid, expired, or already used",
            None,
        ))
    }
}

fn hash_args(args: &LocalTransferArgs) -> [u8; 32] {
    let mut hash = Sha256::new();
    for value in [&args.session_id, &args.local_path, &args.remote_path] {
        hash.update(value.len().to_le_bytes());
        hash.update(value);
    }
    hash.finalize().into()
}

pub(super) fn decode_response(mut responses: InputResponses) -> Result<ListRootsResult, McpError> {
    let value = responses
        .remove(ROOTS_KEY)
        .filter(|_| responses.is_empty())
        .ok_or_else(|| McpError::invalid_params("Expected one Roots input response", None))?;
    serde_json::from_value(value)
        .map_err(|_| McpError::invalid_params("Invalid Roots input response", None))
}

pub(super) async fn legacy_roots(
    context: &RequestContext<RoleServer>,
) -> Result<ListRootsResult, McpError> {
    let result = tokio::select! {
        _ = context.ct.cancelled() => None,
        result = tokio::time::timeout(ROOTS_TIMEOUT, context.peer.list_roots()) => result.ok().and_then(Result::ok),
    };
    result.ok_or_else(|| McpError::invalid_request("客户端未提供 Roots", None))
}

pub(super) fn rooted_path(
    roots: &ListRootsResult,
    requested: &Path,
    must_exist: bool,
) -> Option<PathBuf> {
    roots.roots.iter().find_map(|root| {
        let root_path = url::Url::parse(&root.uri).ok()?.to_file_path().ok()?;
        let root_path = std::fs::canonicalize(root_path).ok()?;
        rooted_candidate(&root_path, requested, must_exist)
    })
}

pub(super) fn rooted_candidate(
    root_path: &Path,
    requested: &Path,
    must_exist: bool,
) -> Option<PathBuf> {
    let candidate = if must_exist || std::fs::symlink_metadata(requested).is_ok() {
        // 已存在的终点也要解析，避免把 Roots 内的符号链接视为授权目标。
        std::fs::canonicalize(requested).ok()
    } else {
        requested
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .and_then(|parent| requested.file_name().map(|name| parent.join(name)))
    }?;
    candidate.strip_prefix(root_path).ok()?;
    Some(candidate)
}

#[cfg(test)]
#[tokio::test(start_paused = true)]
async fn pending_roots_are_bounded_and_expire() {
    let pending = PendingRoots::default();
    let args = LocalTransferArgs {
        session_id: "session".into(),
        local_path: "local-path".into(),
        remote_path: "remote-path".into(),
        extra: JsonObject::new(),
    };
    let first = pending.begin(LocalTransfer::Upload, &args).unwrap();
    for _ in 1..MAX_PENDING {
        pending.begin(LocalTransfer::Upload, &args).unwrap();
    }
    assert!(pending.begin(LocalTransfer::Upload, &args).is_none());
    tokio::time::advance(ROOTS_TIMEOUT).await;
    assert!(pending
        .resume(&first.request_state.unwrap(), LocalTransfer::Upload, &args)
        .is_err());
    assert!(pending.begin(LocalTransfer::Upload, &args).is_some());
}
