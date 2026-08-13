use crate::models::AppError;
use axum::http::StatusCode;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub(super) struct TransferTicket {
    pub(super) session_id: String,
    pub(super) kind: TransferTicketKind,
    pub(super) expires_at: Instant,
    pub(super) state: TransferTicketState,
    pub(super) cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub(super) enum TransferTicketKind {
    Download {
        remote_path: String,
        file_name: String,
    },
    Upload {
        remote_directory: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TransferTicketState {
    Ready,
    Active,
}

pub(crate) struct IssuedTransferLink {
    pub url: String,
    pub expires_in_seconds: u64,
    pub expires_at_unix_ms: u128,
}

pub(super) struct TicketStore {
    tickets: Mutex<HashMap<String, TransferTicket>>,
    max_tickets: usize,
}

impl TicketStore {
    pub(super) fn new(max_tickets: usize) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            max_tickets,
        }
    }

    pub(super) async fn issue(
        &self,
        session_id: String,
        kind: TransferTicketKind,
        ttl: Duration,
    ) -> Result<String, AppError> {
        let now = Instant::now();
        let mut tickets = self.tickets.lock().await;
        prune_expired(&mut tickets, now);
        if tickets.len() >= self.max_tickets {
            return Err(AppError::Busy("一次性传输链接数量已达上限".to_owned()));
        }
        let token = new_ticket_token();
        tickets.insert(
            token.clone(),
            TransferTicket {
                session_id,
                kind,
                expires_at: now + ttl,
                state: TransferTicketState::Ready,
                cancellation: CancellationToken::new(),
            },
        );
        Ok(token)
    }

    pub(super) async fn clear(&self) {
        let mut tickets = self.tickets.lock().await;
        for ticket in tickets.values() {
            ticket.cancellation.cancel();
        }
        tickets.clear();
    }

    #[cfg(test)]
    pub(super) async fn count(&self) -> usize {
        self.tickets.lock().await.len()
    }

    pub(super) async fn peek(
        &self,
        token: &str,
        upload: bool,
    ) -> Result<TransferTicket, StatusCode> {
        let mut tickets = self.tickets.lock().await;
        prune_expired(&mut tickets, Instant::now());
        let ticket = tickets.get(token).ok_or(StatusCode::NOT_FOUND)?;
        ticket_kind_matches(ticket, upload)
            .then(|| ticket.clone())
            .ok_or(StatusCode::NOT_FOUND)
    }

    pub(super) async fn begin(
        &self,
        token: &str,
        upload: bool,
    ) -> Result<TransferTicket, StatusCode> {
        let mut tickets = self.tickets.lock().await;
        prune_expired(&mut tickets, Instant::now());
        let ticket = tickets.get_mut(token).ok_or(StatusCode::NOT_FOUND)?;
        if !ticket_kind_matches(ticket, upload) {
            return Err(StatusCode::NOT_FOUND);
        }
        if ticket.state == TransferTicketState::Active {
            return Err(StatusCode::CONFLICT);
        }
        ticket.state = TransferTicketState::Active;
        Ok(ticket.clone())
    }

    pub(super) async fn finish_download(&self, token: &str) {
        let mut tickets = self.tickets.lock().await;
        let remove = tickets
            .get(token)
            .is_some_and(|ticket| ticket.expires_at <= Instant::now());
        if remove {
            tickets.remove(token);
        } else if let Some(ticket) = tickets.get_mut(token) {
            ticket.state = TransferTicketState::Ready;
        }
    }

    pub(super) async fn finish_upload(&self, token: &str, succeeded: bool) {
        let mut tickets = self.tickets.lock().await;
        let remove = succeeded
            || tickets
                .get(token)
                .is_some_and(|ticket| ticket.expires_at <= Instant::now());
        if remove {
            tickets.remove(token);
        } else if let Some(ticket) = tickets.get_mut(token) {
            ticket.state = TransferTicketState::Ready;
        }
    }

    #[cfg(test)]
    pub(super) async fn expire(&self, token: &str) {
        if let Some(ticket) = self.tickets.lock().await.get_mut(token) {
            ticket.expires_at = Instant::now();
        }
    }
}

fn ticket_kind_matches(ticket: &TransferTicket, upload: bool) -> bool {
    matches!(
        (&ticket.kind, upload),
        (TransferTicketKind::Download { .. }, false) | (TransferTicketKind::Upload { .. }, true)
    )
}

fn prune_expired(tickets: &mut HashMap<String, TransferTicket>, now: Instant) {
    tickets.retain(|_, ticket| {
        let keep = ticket.state == TransferTicketState::Active || ticket.expires_at > now;
        if !keep {
            ticket.cancellation.cancel();
        }
        keep
    });
}

fn new_ticket_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
