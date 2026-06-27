use crate::models::{
    AppError, CreateSessionPayload, Session, SessionConnection, SessionGroup, SessionStatus,
    UpdateSessionPayload,
};
use std::collections::BTreeMap;
use uuid::Uuid;

pub struct SessionService {
    sessions: Vec<Session>,
}

impl Default for SessionService {
    fn default() -> Self {
        Self {
            sessions: seed_sessions(),
        }
    }
}

impl SessionService {
    pub fn list_groups(&self) -> Vec<SessionGroup> {
        let mut groups = BTreeMap::<String, Vec<Session>>::new();

        for session in &self.sessions {
            groups
                .entry(session.group.clone())
                .or_default()
                .push(session.clone());
        }

        groups
            .into_iter()
            .map(|(name, sessions)| SessionGroup { name, sessions })
            .collect()
    }

    pub fn create(&mut self, payload: CreateSessionPayload) -> Session {
        let session = Session {
            id: Uuid::new_v4().to_string(),
            name: payload.name.trim().to_owned(),
            host: payload.host.trim().to_owned(),
            port: payload.port,
            username: payload.username.trim().to_owned(),
            group: normalize_group(&payload.group),
            tags: payload.tags,
            status: SessionStatus::Online,
            latency_ms: Some(28),
            os: "Ubuntu 22.04.4 LTS".to_owned(),
        };

        self.sessions.push(session.clone());
        session
    }

    pub fn update(&mut self, payload: UpdateSessionPayload) -> Result<Session, AppError> {
        let session = self
            .sessions
            .iter_mut()
            .find(|candidate| candidate.id == payload.id)
            .ok_or_else(|| AppError::NotFound("未找到指定 session".to_owned()))?;

        if let Some(name) = payload.name {
            session.name = name.trim().to_owned();
        }
        if let Some(host) = payload.host {
            session.host = host.trim().to_owned();
        }
        if let Some(port) = payload.port {
            session.port = port;
        }
        if let Some(username) = payload.username {
            session.username = username.trim().to_owned();
        }
        if let Some(group) = payload.group {
            session.group = normalize_group(&group);
        }
        if let Some(tags) = payload.tags {
            session.tags = tags;
        }

        Ok(session.clone())
    }

    pub fn delete(&mut self, session_id: &str) -> Result<(), AppError> {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != session_id);

        if self.sessions.len() == before {
            return Err(AppError::NotFound("未找到指定 session".to_owned()));
        }

        Ok(())
    }

    pub fn open(&self, session_id: &str) -> Result<SessionConnection, AppError> {
        let session = self.find(session_id)?;

        Ok(SessionConnection {
            session: session.clone(),
            terminal_output: terminal_output(session),
        })
    }

    pub fn find(&self, session_id: &str) -> Result<&Session, AppError> {
        self.sessions
            .iter()
            .find(|session| session.id == session_id)
            .ok_or_else(|| AppError::NotFound("未找到指定 session".to_owned()))
    }
}

fn normalize_group(group: &str) -> String {
    let trimmed = group.trim();

    if trimmed.is_empty() {
        "Development".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn seed_sessions() -> Vec<Session> {
    let mut sessions = vec![
        mock_session(
            "prod-api-01",
            "prod-api-01",
            "10.0.1.10",
            "ubuntu",
            "Production",
            vec!["ubuntu"],
            22,
        ),
        mock_session(
            "prod-db-01",
            "prod-db-01",
            "10.0.1.20",
            "postgres",
            "Production",
            vec!["postgres"],
            18,
        ),
        mock_session(
            "prod-web-01",
            "prod-web-01",
            "10.0.1.30",
            "ubuntu",
            "Production",
            vec!["ubuntu"],
            32,
        ),
        mock_session(
            "staging-db",
            "staging-db",
            "10.0.2.15",
            "devuser",
            "Development",
            vec!["postgres"],
            24,
        ),
        mock_session(
            "staging-api",
            "staging-api",
            "10.0.2.16",
            "devuser",
            "Development",
            vec!["api"],
            27,
        ),
        mock_session(
            "dev-box",
            "dev-box",
            "10.0.2.50",
            "devuser",
            "Development",
            vec!["tooling"],
            45,
        ),
        mock_session(
            "test-api",
            "test-api",
            "10.0.3.10",
            "tester",
            "Testing",
            vec!["api"],
            31,
        ),
        mock_session(
            "test-db",
            "test-db",
            "10.0.3.11",
            "tester",
            "Testing",
            vec!["postgres"],
            41,
        ),
    ];

    if let Some(session) = sessions.iter_mut().find(|session| session.id == "test-db") {
        session.status = SessionStatus::Offline;
        session.latency_ms = None;
    }

    sessions
}

fn mock_session(
    id: &str,
    name: &str,
    host: &str,
    username: &str,
    group: &str,
    tags: Vec<&str>,
    latency_ms: u16,
) -> Session {
    Session {
        id: id.to_owned(),
        name: name.to_owned(),
        host: host.to_owned(),
        port: 22,
        username: username.to_owned(),
        group: group.to_owned(),
        tags: tags.into_iter().map(str::to_owned).collect(),
        status: SessionStatus::Online,
        latency_ms: Some(latency_ms),
        os: "Ubuntu 22.04.4 LTS".to_owned(),
    }
}

fn terminal_output(session: &Session) -> Vec<String> {
    vec![
        format!(
            "Welcome to {} (GNU/Linux 5.15.0-103-generic x86_64)",
            session.os
        ),
        "* Documentation:  https://help.ubuntu.com".to_owned(),
        "* Management:     https://landscape.canonical.com".to_owned(),
        "* Support:        https://ubuntu.com/pro".to_owned(),
        String::new(),
        "Last login: May 23 09:14:32 2024 from 10.0.2.100".to_owned(),
        format!("{}@{}:~$ whoami", session.username, session.name),
        session.username.clone(),
        format!("{}@{}:~$ hostname -I", session.username, session.name),
        format!("{} fe80::215:5dff:febd:abcd", session.host),
        format!("{}@{}:~$ uptime", session.username, session.name),
        "09:42:11 up 17 days, 2 users, load average: 0.15, 0.19, 0.23".to_owned(),
        format!(
            "{}@{}:~$ docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
            session.username, session.name
        ),
        "NAMES          STATUS       PORTS".to_owned(),
        "postgres-db    Up 17 days   0.0.0.0:5432->5432/tcp".to_owned(),
        "redis-cache    Up 17 days   0.0.0.0:6379->6379/tcp".to_owned(),
        "nginx-proxy    Up 17 days   0.0.0.0:80->80/tcp".to_owned(),
        String::new(),
        format!("{}@{}:~$ ", session.username, session.name),
    ]
}
