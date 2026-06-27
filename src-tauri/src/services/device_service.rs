use crate::models::{DeviceStatus, ServiceStatus, Session};

pub struct DeviceService;

impl DeviceService {
    pub fn status(&self, session: &Session) -> DeviceStatus {
        DeviceStatus {
            session_id: session.id.clone(),
            ip: session.host.clone(),
            username: session.username.clone(),
            os: session.os.clone(),
            uptime: "17 days, 2 users".to_owned(),
            cpu_percent: 14,
            memory_percent: 58,
            disk_percent: 24,
            services: vec![
                service("nginx", "active", 80),
                service("postgres", "active", 5432),
                service("redis", "active", 6379),
            ],
        }
    }
}

fn service(name: &str, state: &str, port: u16) -> ServiceStatus {
    ServiceStatus {
        name: name.to_owned(),
        state: state.to_owned(),
        port,
    }
}
