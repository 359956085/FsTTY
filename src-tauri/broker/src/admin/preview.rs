use super::{dialog, Theme};
use crate::protocol::{Change, Review, Target};
use windows_sys::Win32::Foundation::HWND;

pub fn fixtures(scenario: &str) -> crate::Result<Vec<Review>> {
    let target = Target {
        id: "00000000-0000-4000-8000-000000000001".into(),
        host: "amazon-ubuntu-1.example.test".into(),
        port: 22,
        username: "ubuntu".into(),
        private_key: scenario == "key",
    };
    let mut review = Review {
        target: Some(target.clone()),
        owner_sid: "S-1-5-21-1000-2000-3000-1001".into(),
        change: Change::Configure {
            target: target.clone(),
            replace_secret: true,
        },
        revision: 3,
        old_fingerprint: String::new(),
        fingerprint: "SHA256:Zx5Xn38lmgUQ6eWTpRvy0qM2h3C1B6NfHkSzJuDaL9E".into(),
        needs_secret: true,
        import: false,
    };
    match scenario {
        "password" | "key" => {}
        "migrate" | "batch" => {
            review.import = true;
            review.needs_secret = false;
        }
        "delete" | "batch-delete" => {
            review.change = Change::Delete {
                id: target.id.clone(),
            };
            review.needs_secret = false;
            review.fingerprint.clear();
        }
        "trust" => {
            review.change = Change::Trust {
                id: target.id.clone(),
            };
            review.needs_secret = false;
            review.old_fingerprint = "SHA256:mY6rTuL3xvNWQbnHt4jP8dS0foCE2G1p5A7Vz9KcBqI".into();
        }
        "long" => {
            let mut long = target.clone();
            long.host = format!("{}.example.test", "long-host-".repeat(23));
            long.username = "very-long-username-".repeat(6);
            review.target = Some(long.clone());
            review.change = Change::Configure {
                target: long,
                replace_secret: true,
            };
        }
        _ => return Err("未知预览场景".into()),
    }
    let count = match scenario {
        "batch" => 32,
        "batch-delete" => 500,
        _ => 1,
    };
    Ok((0..count)
        .map(|index| {
            let mut item = review.clone();
            let id = format!("00000000-0000-4000-8000-{:012}", index + 1);
            if let Some(target) = &mut item.target {
                target.id = id.clone();
            }
            match &mut item.change {
                Change::Configure { target, .. } => target.id = id,
                Change::Delete { id: old } | Change::Trust { id: old } => *old = id,
            };
            item
        })
        .collect())
}

pub fn show(scenario: &str, theme: Theme, dpi: u32, hook: Option<fn(HWND)>) -> crate::Result<()> {
    if ![96, 144, 192].contains(&dpi) {
        return Err("预览 DPI 必须为 96、144 或 192".into());
    }
    dialog::preview(fixtures(scenario)?, theme, dpi, hook)
}

/// 仅在预览窗口所属线程调用，核对合成会话布局。
#[allow(clippy::missing_safety_doc)]
pub unsafe fn audit(window: HWND) -> crate::Result<()> {
    dialog::audit(window)
}
