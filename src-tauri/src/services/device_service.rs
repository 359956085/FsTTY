use crate::models::{AppError, DeviceStatus};
use crate::services::ConnectionManager;
use std::time::Duration;

const PROC_STAT: &str = "cat /proc/stat";
const PROC_MEMINFO: &str = "cat /proc/meminfo";
const DISK_USAGE: &str = "df -Pk /";
const OS_RELEASE: &str = "cat /etc/os-release";
const ARCHITECTURE: &str = "uname -m";
const UPTIME: &str = "cat /proc/uptime";

pub struct DeviceService;

impl DeviceService {
    pub async fn status(
        &self,
        connections: &ConnectionManager,
        connection_id: &str,
    ) -> Result<DeviceStatus, AppError> {
        let session_id = connections.session_id(connection_id).await?;
        let cpu = read_cpu(connections, connection_id);
        let memory = read_text(connections, connection_id, PROC_MEMINFO);
        let disk = read_text(connections, connection_id, DISK_USAGE);
        let os = read_text(connections, connection_id, OS_RELEASE);
        let architecture = read_text(connections, connection_id, ARCHITECTURE);
        let uptime = read_text(connections, connection_id, UPTIME);
        let (cpu, memory, disk, os, architecture, uptime) =
            tokio::join!(cpu, memory, disk, os, architecture, uptime);

        let (cpu_percent, cpu_cores) = cpu
            .and_then(|(first, second)| parse_cpu(&first, &second))
            .map(|value| (Some(value.0), Some(value.1)))
            .unwrap_or((None, None));
        let (memory_percent, memory_used_gb, memory_total_gb) = memory
            .as_deref()
            .and_then(parse_memory)
            .map(|value| (Some(value.0), Some(value.1), Some(value.2)))
            .unwrap_or((None, None, None));
        let (disk_percent, disk_used_gb, disk_total_gb) = disk
            .as_deref()
            .and_then(parse_disk)
            .map(|value| (Some(value.0), Some(value.1), Some(value.2)))
            .unwrap_or((None, None, None));
        let os = os.as_deref().and_then(parse_os_release);
        let architecture = architecture
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let uptime_seconds = uptime.as_deref().and_then(parse_uptime);
        let available = cpu_percent.is_some()
            || memory_percent.is_some()
            || disk_percent.is_some()
            || os.is_some()
            || architecture.is_some();

        Ok(DeviceStatus {
            session_id,
            available,
            os,
            architecture,
            uptime_seconds,
            cpu_percent,
            cpu_cores,
            memory_percent,
            memory_used_gb,
            memory_total_gb,
            disk_percent,
            disk_used_gb,
            disk_total_gb,
        })
    }
}

async fn read_cpu(
    connections: &ConnectionManager,
    connection_id: &str,
) -> Option<(String, String)> {
    let first = read_text(connections, connection_id, PROC_STAT).await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let second = read_text(connections, connection_id, PROC_STAT).await?;
    Some((first, second))
}

async fn read_text(
    connections: &ConnectionManager,
    connection_id: &str,
    command: &'static str,
) -> Option<String> {
    String::from_utf8(connections.exec(connection_id, command).await.ok()?).ok()
}

fn parse_cpu(first: &str, second: &str) -> Option<(u8, u16)> {
    let (first_total, first_idle) = parse_cpu_total(first)?;
    let (second_total, second_idle) = parse_cpu_total(second)?;
    let total_delta = second_total.checked_sub(first_total)?;
    let idle_delta = second_idle.checked_sub(first_idle)?;
    if total_delta == 0 || idle_delta > total_delta {
        return None;
    }
    let percent = (((total_delta - idle_delta) as f64 / total_delta as f64) * 100.0)
        .round()
        .clamp(0.0, 100.0) as u8;
    let cores = second
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .filter(|label| {
            label.strip_prefix("cpu").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
            })
        })
        .count();
    Some((percent, u16::try_from(cores).ok()?))
}

fn parse_cpu_total(value: &str) -> Option<(u64, u64)> {
    let fields = value.lines().next()?.split_whitespace().collect::<Vec<_>>();
    if fields.first().copied() != Some("cpu") || fields.len() < 5 {
        return None;
    }
    let values = fields[1..]
        .iter()
        .map(|field| field.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let total = values.iter().sum();
    let idle =
        values.get(3).copied().unwrap_or_default() + values.get(4).copied().unwrap_or_default();
    Some((total, idle))
}

fn parse_memory(value: &str) -> Option<(u8, f64, f64)> {
    let read_kib = |name: &str| {
        value.lines().find_map(|line| {
            let (key, rest) = line.split_once(':')?;
            (key == name)
                .then(|| rest.split_whitespace().next()?.parse::<u64>().ok())
                .flatten()
        })
    };
    let total = read_kib("MemTotal")?;
    let available = read_kib("MemAvailable")
        .or_else(|| Some(read_kib("MemFree")? + read_kib("Buffers")? + read_kib("Cached")?))?;
    if total == 0 || available > total {
        return None;
    }
    let used = total - available;
    let percent = ((used as f64 / total as f64) * 100.0)
        .round()
        .clamp(0.0, 100.0) as u8;
    Some((percent, kib_to_gib(used), kib_to_gib(total)))
}

fn parse_disk(value: &str) -> Option<(u8, f64, f64)> {
    let fields = value.lines().last()?.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 6 {
        return None;
    }
    let total = fields[1].parse::<u64>().ok()?;
    let used = fields[2].parse::<u64>().ok()?;
    let percent = fields[4].trim_end_matches('%').parse::<u8>().ok()?.min(100);
    Some((percent, kib_to_gib(used), kib_to_gib(total)))
}

fn parse_os_release(value: &str) -> Option<String> {
    let raw = value.lines().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })?;
    Some(raw.trim_matches('"').replace("\\\"", "\""))
}

fn parse_uptime(value: &str) -> Option<u64> {
    value
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| seconds.floor() as u64)
}

fn kib_to_gib(value: u64) -> f64 {
    value as f64 / 1024.0 / 1024.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_metrics() {
        let first = "cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400\ncpu1 50 0 50 400\n";
        let second = "cpu  150 0 150 900 0 0 0 0\ncpu0 75 0 75 450\ncpu1 75 0 75 450\n";
        assert_eq!(parse_cpu(first, second), Some((50, 2)));
        assert_eq!(
            parse_memory("MemTotal: 4096 kB\nMemAvailable: 3072 kB\n").map(|value| value.0),
            Some(25)
        );
        assert_eq!(
            parse_disk("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1000 250 750 25% /\n")
                .map(|value| value.0),
            Some(25)
        );
        assert_eq!(
            parse_os_release("NAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n"),
            Some("Ubuntu 24.04 LTS".to_owned())
        );
    }
}
