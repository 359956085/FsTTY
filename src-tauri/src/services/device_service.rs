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
            cpu_percent: 18,
            cpu_cores: 4,
            memory_percent: 28,
            memory_used_gb: 1.1,
            memory_total_gb: 3.9,
            disk_percent: 23,
            disk_used_gb: 9.1,
            disk_total_gb: 39.1,
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
