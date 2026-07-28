use crate::models::{AppError, DeviceStatus};
use crate::services::ConnectionManager;
use std::collections::HashMap;

const CPU_FIRST: &str = "cpu-first";
const CPU_SECOND: &str = "cpu-second";
const MEMORY: &str = "memory";
const DISK: &str = "disk";
const OS: &str = "os";
const ARCHITECTURE: &str = "architecture";
const UPTIME: &str = "uptime";
const ROUTE: &str = "route";
const NETWORK: &str = "network";

// 每轮只创建一个远程执行通道，避免多标签轮询时反复建立 SSH channel。
const DEVICE_SNAPSHOT: &str = r#"printf '%s\n' '__FSTTY_CPU_FIRST__'
cat /proc/stat 2>/dev/null
sleep 0.25
printf '%s\n' '__FSTTY_CPU_SECOND__'
cat /proc/stat 2>/dev/null
printf '%s\n' '__FSTTY_MEMORY__'
cat /proc/meminfo 2>/dev/null
printf '%s\n' '__FSTTY_DISK__'
df -Pk / 2>/dev/null
printf '%s\n' '__FSTTY_OS__'
cat /etc/os-release 2>/dev/null
printf '%s\n' '__FSTTY_ARCHITECTURE__'
uname -m 2>/dev/null
printf '%s\n' '__FSTTY_UPTIME__'
cat /proc/uptime 2>/dev/null
printf '%s\n' '__FSTTY_ROUTE__'
cat /proc/net/route 2>/dev/null
printf '%s\n' '__FSTTY_NETWORK__'
cat /proc/net/dev 2>/dev/null"#;

#[derive(Clone, Copy)]
pub struct DeviceService;

impl DeviceService {
    pub async fn status(
        &self,
        connections: &ConnectionManager,
        connection_id: &str,
    ) -> Result<DeviceStatus, AppError> {
        let session_id = connections.session_id(connection_id).await?;
        let output = connections.exec(connection_id, DEVICE_SNAPSHOT).await?;
        let output = String::from_utf8(output).unwrap_or_default();
        let sections = parse_snapshot(&output);

        let (cpu_percent, cpu_cores) = sections
            .get(CPU_FIRST)
            .zip(sections.get(CPU_SECOND))
            .and_then(|(first, second)| parse_cpu(first, second))
            .map(|value| (Some(value.0), Some(value.1)))
            .unwrap_or((None, None));
        let (memory_percent, memory_used_gb, memory_total_gb) = sections
            .get(MEMORY)
            .map(String::as_str)
            .and_then(parse_memory)
            .map(|value| (Some(value.0), Some(value.1), Some(value.2)))
            .unwrap_or((None, None, None));
        let (disk_percent, disk_used_gb, disk_total_gb) = sections
            .get(DISK)
            .map(String::as_str)
            .and_then(parse_disk)
            .map(|value| (Some(value.0), Some(value.1), Some(value.2)))
            .unwrap_or((None, None, None));
        let os = sections
            .get(OS)
            .map(String::as_str)
            .and_then(parse_os_release);
        let architecture = sections
            .get(ARCHITECTURE)
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let uptime_seconds = sections
            .get(UPTIME)
            .map(String::as_str)
            .and_then(parse_uptime);
        let (network_received_bytes, network_transmitted_bytes) = sections
            .get(ROUTE)
            .zip(sections.get(NETWORK))
            .and_then(|(route, network)| parse_network(route, network))
            .map(|value| (Some(value.0), Some(value.1)))
            .unwrap_or((None, None));
        let available = cpu_percent.is_some()
            || memory_percent.is_some()
            || disk_percent.is_some()
            || os.is_some()
            || architecture.is_some()
            || network_received_bytes.is_some();

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
            network_received_bytes,
            network_transmitted_bytes,
        })
    }
}

fn parse_snapshot(value: &str) -> HashMap<&'static str, String> {
    let mut sections = HashMap::new();
    let mut current = None;
    for line in value.lines() {
        if let Some(section) = snapshot_section(line) {
            current = Some(section);
            sections.entry(section).or_insert_with(String::new);
            continue;
        }
        if let Some(section) = current {
            let content = sections.entry(section).or_insert_with(String::new);
            content.push_str(line);
            content.push('\n');
        }
    }
    sections
}

fn snapshot_section(line: &str) -> Option<&'static str> {
    match line.trim() {
        "__FSTTY_CPU_FIRST__" => Some(CPU_FIRST),
        "__FSTTY_CPU_SECOND__" => Some(CPU_SECOND),
        "__FSTTY_MEMORY__" => Some(MEMORY),
        "__FSTTY_DISK__" => Some(DISK),
        "__FSTTY_OS__" => Some(OS),
        "__FSTTY_ARCHITECTURE__" => Some(ARCHITECTURE),
        "__FSTTY_UPTIME__" => Some(UPTIME),
        "__FSTTY_ROUTE__" => Some(ROUTE),
        "__FSTTY_NETWORK__" => Some(NETWORK),
        _ => None,
    }
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

fn parse_network(route: &str, network: &str) -> Option<(u64, u64)> {
    let default_interface = route.lines().skip(1).find_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 4 || fields[1] != "00000000" {
            return None;
        }
        let flags = u16::from_str_radix(fields[3], 16).ok()?;
        (flags & 1 != 0).then_some(fields[0])
    });
    let interfaces = network.lines().filter_map(|line| {
        let (name, counters) = line.split_once(':')?;
        let name = name.trim();
        let fields = counters.split_whitespace().collect::<Vec<_>>();
        if name.is_empty() || fields.len() < 16 {
            return None;
        }
        Some((
            name,
            fields[0].parse::<u64>().ok()?,
            fields[8].parse::<u64>().ok()?,
        ))
    });
    let interfaces = interfaces.collect::<Vec<_>>();
    if let Some(name) = default_interface {
        if let Some((_, received, transmitted)) = interfaces
            .iter()
            .find(|(interface, _, _)| *interface == name)
        {
            return Some((*received, *transmitted));
        }
    }

    let mut found = false;
    let mut received = 0_u64;
    let mut transmitted = 0_u64;
    for (name, interface_received, interface_transmitted) in interfaces {
        if name == "lo" {
            continue;
        }
        found = true;
        received = received.saturating_add(interface_received);
        transmitted = transmitted.saturating_add(interface_transmitted);
    }
    found.then_some((received, transmitted))
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

    #[test]
    fn parses_combined_snapshot_sections() {
        let snapshot = "__FSTTY_CPU_FIRST__\ncpu 1 2 3 4\n\
                        __FSTTY_CPU_SECOND__\ncpu 2 3 4 5\n\
                        __FSTTY_MEMORY__\nMemTotal: 4096 kB\n";
        let sections = parse_snapshot(snapshot);
        assert_eq!(
            sections.get(CPU_FIRST).map(String::as_str),
            Some("cpu 1 2 3 4\n")
        );
        assert_eq!(
            sections.get(MEMORY).map(String::as_str),
            Some("MemTotal: 4096 kB\n")
        );
    }

    #[test]
    fn selects_default_network_interface() {
        let route = "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n\
                     eth0 00000000 0100007F 0003 0 0 0 00000000 0 0 0\n";
        let network = "Inter-| Receive | Transmit\n\
                       lo: 50 0 0 0 0 0 0 0 60 0 0 0 0 0 0 0\n\
                       eth0: 1000 0 0 0 0 0 0 0 2500 0 0 0 0 0 0 0\n\
                       docker0: 400 0 0 0 0 0 0 0 800 0 0 0 0 0 0 0\n";
        assert_eq!(parse_network(route, network), Some((1000, 2500)));
    }

    #[test]
    fn falls_back_to_non_loopback_network_total() {
        let network = "lo: 50 0 0 0 0 0 0 0 60 0 0 0 0 0 0 0\n\
                       eth0: 1000 0 0 0 0 0 0 0 2500 0 0 0 0 0 0 0\n\
                       eth1: 400 0 0 0 0 0 0 0 800 0 0 0 0 0 0 0\n";
        assert_eq!(parse_network("", network), Some((1400, 3300)));
        assert_eq!(parse_network("", "broken"), None);
    }
}
