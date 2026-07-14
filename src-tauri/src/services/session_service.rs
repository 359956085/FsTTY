use crate::models::{
    AppError, CreateSessionPayload, Session, SessionConnection, SessionGroup, SessionStatus,
    UpdateSessionPayload,
};
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
        let mut groups = Vec::<SessionGroup>::new();

        for session in &self.sessions {
            if let Some(group) = groups.iter_mut().find(|group| group.name == session.group) {
                group.sessions.push(session.clone());
            } else {
                groups.push(SessionGroup {
                    name: session.group.clone(),
                    sessions: vec![session.clone()],
                });
            }
        }

        groups
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
        "开发环境".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn seed_sessions() -> Vec<Session> {
    vec![
        mock_session(
            "prod-web-01",
            "Prod-Web-01",
            "10.0.0.11",
            "root",
            "生产环境",
            vec!["web"],
            18,
        ),
        mock_session(
            "prod-db-01",
            "Prod-DB-01",
            "10.0.0.12",
            "rrag",
            "生产环境",
            vec!["postgres"],
            21,
        ),
        mock_session(
            "prod-cache-01",
            "Prod-Cache-01",
            "10.0.0.13",
            "root",
            "生产环境",
            vec!["redis"],
            16,
        ),
        mock_session(
            "test-web-01",
            "Test-Web-01",
            "10.0.1.21",
            "ubuntu",
            "测试环境",
            vec!["web"],
            25,
        ),
        mock_session(
            "test-api-01",
            "Test-API-01",
            "10.0.1.22",
            "ubuntu",
            "测试环境",
            vec!["api"],
            29,
        ),
        mock_session(
            "dev-01",
            "Dev-01",
            "10.0.2.31",
            "developer",
            "开发环境",
            vec!["tooling"],
            35,
        ),
        mock_session(
            "dev-02",
            "Dev-02",
            "10.0.2.32",
            "developer",
            "开发环境",
            vec!["tooling"],
            38,
        ),
        mock_session(
            "aws-ec2",
            "AWS-EC2",
            "3.22.10.8",
            "ec2-user",
            "云服务器",
            vec!["aws"],
            52,
        ),
        mock_session(
            "aliyun-ecs",
            "Aliyun-ECS",
            "47.100.1.25",
            "root",
            "云服务器",
            vec!["aliyun"],
            48,
        ),
    ]
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
    let prompt = format!(
        "{}@{}:~{}",
        session.username,
        session.id,
        if session.username == "root" { "#" } else { "$" }
    );

    vec![
        "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-101-generic x86_64)".to_owned(),
        String::new(),
        " * Documentation:  https://help.ubuntu.com".to_owned(),
        " * Management:     https://landscape.canonical.com".to_owned(),
        " * Support:        https://ubuntu.com/advantage".to_owned(),
        String::new(),
        "System information as of Fri May 17 14:23:18 CST 2024".to_owned(),
        String::new(),
        "  System load:  0.08              Processes:             124".to_owned(),
        "  Usage of /:   23.1% of 39.05GB  Users logged in:       1".to_owned(),
        format!(
            "  Memory usage: 28%              IPv4 address for eth0: {}",
            session.host
        ),
        "  Swap usage:   0%".to_owned(),
        String::new(),
        "0 updates can be applied immediately.".to_owned(),
        String::new(),
        "Last login: Fri May 17 13:58:41 2024 from 10.0.0.5".to_owned(),
        format!("\u{1b}[32m{prompt}\u{1b}[0m ls -lah"),
        "total 80K".to_owned(),
        "drwx------  7 root root 4.0K May 17 14:21 .".to_owned(),
        "drwxr-xr-x 23 root root 4.0K Apr 12 09:15 ..".to_owned(),
        "-rw-------  1 root root 3.1K Apr 10 03:31 .bash_history".to_owned(),
        "-rw-r--r--  1 root root 3.1K Apr  9 10:21 .bashrc".to_owned(),
        "drwx------  3 root root 4.0K Mar 14 15:22 \u{1b}[36m.cache\u{1b}[0m".to_owned(),
        "drwxr-xr-x  3 root root 4.0K Mar 14 15:22 \u{1b}[36m.config\u{1b}[0m".to_owned(),
        "-rw-r--r--  1 root root 1.6K Apr  9 10:21 .profile".to_owned(),
        "drwx------  2 root root 4.0K Apr 11 11:08 \u{1b}[36m.ssh\u{1b}[0m".to_owned(),
        "-rw-r--r--  1 root root   33 Apr  9 10:21 .vimrc".to_owned(),
        "drwxr-xr-x  5 root root 4.0K Apr 25 16:45 \u{1b}[36mwww\u{1b}[0m".to_owned(),
        format!("\u{1b}[32m{prompt}\u{1b}[0m df -hT"),
        "Filesystem     Type      Size  Used Avail Use% Mounted on".to_owned(),
        "/dev/vda1      ext4       40G  9.1G   29G  24% /".to_owned(),
        "tmpfs          tmpfs     2.0G     0  2.0G   0% /dev/shm".to_owned(),
        "tmpfs          tmpfs     793M  1.4M  792M   1% /run".to_owned(),
        "tmpfs          tmpfs     5.0M     0  5.0M   0% /run/lock".to_owned(),
        "/dev/vda15     vfat      105M  6.1M   99M   6% /boot/efi".to_owned(),
        format!("\u{1b}[32m{prompt}\u{1b}[0m "),
    ]
}
