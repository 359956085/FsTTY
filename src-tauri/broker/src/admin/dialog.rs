use super::{
    appearance::{color, Palette, Theme},
    clipboard_key, input, secret_procedure,
};
use crate::{
    protocol::{Change, Review, Secrets},
    windows::{wide, Local},
};
use std::{
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    Security::{Authorization::*, *},
    System::LibraryLoader::GetModuleHandleW,
    UI::{Controls::*, HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
use zeroize::Zeroizing;

const CONFIRM: usize = 1;
const CANCEL: usize = 2;
const PASSWORD: usize = 3;
const KEY: usize = 4;
const DETAILS: usize = 5;
const FOOTER: i32 = 88;

struct Gdi(HGDIOBJ);
impl Drop for Gdi {
    fn drop(&mut self) {
        unsafe {
            DeleteObject(self.0);
        }
    }
}

#[derive(Clone, Copy)]
enum Tone {
    Text,
    Muted,
    Warning,
    Danger,
    Accent,
}
struct Text {
    value: String,
    rect: RECT,
    font: usize,
    tone: Tone,
}
struct Card {
    rect: RECT,
}

pub(super) struct Dialog {
    window: HWND,
    content: HWND,
    password: HWND,
    key: HWND,
    details: HWND,
    confirm: HWND,
    cancel: HWND,
    reviews: Vec<Review>,
    theme: Theme,
    palette: Palette,
    fonts: Vec<Gdi>,
    input_brush: Gdi,
    texts: Vec<Text>,
    cards: Vec<Card>,
    key_material: Zeroizing<String>,
    error: String,
    account: String,
    expanded: bool,
    accepted: bool,
    closed: bool,
    dpi: u32,
    fixed_dpi: bool,
    scroll: i32,
    height: i32,
    password_rect: RECT,
    key_rect: RECT,
    details_rect: RECT,
    wheel: i32,
    drag: Option<(i32, i32)>,
    #[cfg(feature = "approval-preview")]
    preview: bool,
    #[cfg(feature = "approval-preview")]
    seeded: bool,
}

fn rect(x: i32, y: i32, w: i32, h: i32) -> RECT {
    RECT {
        left: x,
        top: y,
        right: x + w,
        bottom: y + h,
    }
}
fn account_name(sid: &str) -> String {
    unsafe {
        let mut raw = null_mut();
        if ConvertStringSidToSidW(wide(sid).as_ptr(), &mut raw) == 0 {
            return "未解析的账号（详见确认详情）".into();
        }
        let _sid = Local(raw);
        let (mut name_size, mut domain_size, mut usage) = (0, 0, 0);
        LookupAccountSidW(
            null(),
            raw,
            null_mut(),
            &mut name_size,
            null_mut(),
            &mut domain_size,
            &mut usage,
        );
        let mut name = vec![0u16; name_size as usize];
        let mut domain = vec![0u16; domain_size as usize];
        if LookupAccountSidW(
            null(),
            raw,
            name.as_mut_ptr(),
            &mut name_size,
            domain.as_mut_ptr(),
            &mut domain_size,
            &mut usage,
        ) == 0
        {
            return "未解析的账号（详见确认详情）".into();
        }
        let name = String::from_utf16_lossy(&name[..name_size as usize]);
        let domain = String::from_utf16_lossy(&domain[..domain_size as usize]);
        if domain.is_empty() {
            name
        } else {
            format!("{domain}\\{name}")
        }
    }
}

pub(super) fn action(reviews: &[Review]) -> &'static str {
    if reviews.len() > 1
        && reviews
            .iter()
            .any(|r| matches!(r.change, Change::Delete { .. }))
        && !reviews
            .iter()
            .all(|r| matches!(r.change, Change::Delete { .. }))
    {
        return "确认凭据变更";
    }
    if reviews
        .iter()
        .all(|r| matches!(r.change, Change::Delete { .. }))
    {
        "删除凭据"
    } else if reviews.iter().all(|r| r.import) {
        "迁移凭据"
    } else if matches!(reviews[0].change, Change::Trust { .. }) {
        "信任此主机"
    } else {
        "保存凭据"
    }
}

impl Dialog {
    fn px(&self, dip: i32) -> i32 {
        (dip * self.dpi as i32 + 48) / 96
    }
    fn private_key(&self) -> bool {
        matches!(&self.reviews[0].change, Change::Configure { target, .. } if target.private_key)
    }
    fn dangerous(&self) -> bool {
        self.reviews
            .iter()
            .any(|r| matches!(r.change, Change::Delete { .. }))
    }
    fn tone(&self, tone: Tone) -> u32 {
        match tone {
            Tone::Text => self.palette.text,
            Tone::Muted => self.palette.muted,
            Tone::Warning => self.palette.warning,
            Tone::Danger => self.palette.danger,
            Tone::Accent => self.palette.accent,
        }
    }
    unsafe fn create_fonts(&mut self) {
        self.fonts = ["Segoe UI", "Microsoft YaHei UI"]
            .into_iter()
            .flat_map(|family| {
                [(14, 400), (22, 600), (12, 400), (15, 600)]
                    .into_iter()
                    .map(move |(size, weight)| (family, size, weight))
            })
            .map(|(family, size, weight)| {
                Gdi(CreateFontW(
                    -self.px(size),
                    0,
                    0,
                    0,
                    weight,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET as u32,
                    OUT_DEFAULT_PRECIS as u32,
                    CLIP_DEFAULT_PRECIS as u32,
                    CLEARTYPE_QUALITY as u32,
                    DEFAULT_PITCH as u32,
                    wide(family).as_ptr(),
                ))
            })
            .collect();
        for hwnd in [
            self.password,
            self.key,
            self.details,
            self.confirm,
            self.cancel,
        ] {
            if !hwnd.is_null() {
                SendMessageW(hwnd, WM_SETFONT, self.fonts[0].0 as usize, 1);
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    unsafe fn text(
        &mut self,
        dc: HDC,
        value: &str,
        x: i32,
        y: i32,
        width: i32,
        font: usize,
        tone: Tone,
    ) -> i32 {
        let family_font = font
            + if value.chars().any(|c| c >= '\u{2e80}') {
                4
            } else {
                0
            };
        let old = SelectObject(dc, self.fonts[family_font].0);
        let line_height = self.px(if font == 1 {
            32
        } else if font == 2 {
            19
        } else {
            22
        });
        let lines = wrap(dc, value, width.max(1));
        let count = lines.len() as i32;
        for (i, line) in lines.into_iter().enumerate() {
            self.texts.push(Text {
                value: line,
                rect: rect(x, y + i as i32 * line_height, width, line_height),
                font: family_font,
                tone,
            });
        }
        SelectObject(dc, old);
        y + count * line_height
    }
    unsafe fn field(
        &mut self,
        dc: HDC,
        label: &str,
        value: &str,
        y: i32,
        width: i32,
        tone: Tone,
    ) -> i32 {
        let x = self.px(40);
        self.text(dc, label, x, y, self.px(84), 2, Tone::Muted);
        self.text(dc, value, x + self.px(92), y, width - self.px(92), 0, tone) + self.px(8)
    }
    unsafe fn layout(&mut self) {
        let mut client: RECT = zeroed();
        GetClientRect(self.window, &mut client);
        let footer = self.px(FOOTER).min(client.bottom);
        MoveWindow(
            self.content,
            0,
            0,
            client.right,
            (client.bottom - footer).max(1),
            0,
        );
        let mut viewport: RECT = zeroed();
        GetClientRect(self.content, &mut viewport);
        let margin = self.px(24);
        let width = (viewport.right - 2 * margin).max(self.px(180));
        let inner = width - self.px(32);
        self.texts.clear();
        self.cards.clear();
        let dc = GetDC(self.content);
        let mut y = self.text(
            dc,
            "FsTTY  /  SSH 凭据",
            margin,
            margin,
            width,
            2,
            Tone::Muted,
        ) + self.px(5);
        let heading = if self.reviews.len() > 1 {
            format!("{} · {} 个会话", action(&self.reviews), self.reviews.len())
        } else {
            action(&self.reviews).into()
        };
        y = self.text(dc, &heading, margin, y, width, 1, Tone::Text) + self.px(6);
        let account = format!("Windows 账号  {}", self.account);
        y = self.text(dc, &account, margin, y, width, 0, Tone::Muted) + self.px(12);
        self.details_rect = rect(margin, y, self.px(148), self.px(32));
        y += self.px(48);
        for index in 0..self.reviews.len() {
            let review = self.reviews[index].clone();
            let top = y;
            y += self.px(16);
            let title = if self.reviews.len() > 1 {
                format!(
                    "{:02} · {}",
                    index + 1,
                    action(std::slice::from_ref(&review))
                )
            } else {
                "连接目标".into()
            };
            y = self.text(
                dc,
                &title,
                self.px(40),
                y,
                inner,
                3,
                if matches!(review.change, Change::Delete { .. }) {
                    Tone::Danger
                } else {
                    Tone::Text
                },
            ) + self.px(14);
            let target = match &review.change {
                Change::Configure { target, .. } => Some(target),
                _ => review.target.as_ref(),
            };
            if let Some(target) = target {
                y = self.field(dc, "服务器", &target.host, y, inner, Tone::Text);
                y = self.field(dc, "端口", &target.port.to_string(), y, inner, Tone::Text);
                y = self.field(dc, "SSH 用户", &target.username, y, inner, Tone::Text);
                y = self.field(
                    dc,
                    "认证方式",
                    if target.private_key {
                        "私钥"
                    } else {
                        "密码"
                    },
                    y,
                    inner,
                    Tone::Text,
                );
            } else {
                y = self.text(
                    dc,
                    "会话尚未托管，本次仅删除该会话标识。",
                    self.px(40),
                    y,
                    inner,
                    0,
                    Tone::Muted,
                ) + self.px(8);
                y = self.field(
                    dc,
                    "会话 ID",
                    crate::store::change_id(&review.change),
                    y,
                    inner,
                    Tone::Text,
                );
            }
            if !review.fingerprint.is_empty() || !review.old_fingerprint.is_empty() {
                y += self.px(8);
                y = self.text(dc, "主机指纹", self.px(40), y, inner, 3, Tone::Text) + self.px(10);
                let changed = !review.old_fingerprint.is_empty()
                    && !review.fingerprint.is_empty()
                    && review.old_fingerprint != review.fingerprint;
                if changed {
                    y = self.text(
                        dc,
                        "指纹已变化，请核对服务器身份后再确认。",
                        self.px(40),
                        y,
                        inner,
                        0,
                        Tone::Warning,
                    ) + self.px(8);
                    y = self.field(dc, "原指纹", &review.old_fingerprint, y, inner, Tone::Muted);
                }
                let fingerprint = if review.fingerprint.is_empty() {
                    &review.old_fingerprint
                } else {
                    &review.fingerprint
                };
                y = self.field(
                    dc,
                    if changed { "新指纹" } else { "指纹" },
                    fingerprint,
                    y,
                    inner,
                    if changed { Tone::Warning } else { Tone::Text },
                );
            }
            if self.expanded {
                y += self.px(8);
                y = self.field(dc, "Windows SID", &review.owner_sid, y, inner, Tone::Muted);
                y = self.field(
                    dc,
                    "会话 ID",
                    crate::store::change_id(&review.change),
                    y,
                    inner,
                    Tone::Muted,
                );
                y = self.field(
                    dc,
                    "配置版本",
                    &review.revision.to_string(),
                    y,
                    inner,
                    Tone::Muted,
                );
            }
            y += self.px(8);
            self.cards.push(Card {
                rect: rect(margin, top, width, y - top),
            });
            y += self.px(16);
        }
        if self.reviews[0].needs_secret {
            y = self.text(
                dc,
                if self.private_key() {
                    "私钥凭据"
                } else {
                    "登录凭据"
                },
                margin,
                y,
                width,
                3,
                Tone::Text,
            ) + self.px(12);
            if self.private_key() {
                self.key_rect = rect(margin, y, width, self.px(40));
                y += self.px(48);
                y = self.text(
                    dc,
                    if self.key_material.is_empty() {
                        "尚未读取私钥"
                    } else {
                        "私钥已读取，内容不会显示"
                    },
                    margin,
                    y,
                    width,
                    2,
                    if self.key_material.is_empty() {
                        Tone::Muted
                    } else {
                        Tone::Accent
                    },
                ) + self.px(12);
            }
            y = self.text(
                dc,
                if self.private_key() {
                    "私钥口令（未加密可留空）"
                } else {
                    "密码"
                },
                margin,
                y,
                width,
                0,
                Tone::Text,
            ) + self.px(8);
            self.password_rect = rect(margin, y, width, self.px(40));
            y += self.px(50);
        }
        if !self.error.is_empty() {
            y = self.text(dc, &self.error.clone(), margin, y, width, 0, Tone::Danger) + self.px(10);
        }
        let note = if self.dangerous() {
            "删除后无法再使用这份托管凭据建立连接。"
        } else if self.reviews.iter().any(|r| r.import) || self.private_key() {
            "原文件和剪贴板中的私钥仍可被同账号程序读取，请自行清理原件。"
        } else {
            "请核对以上信息。日常连接无需重复确认。"
        };
        y = self.text(dc, note, margin, y, width, 2, Tone::Muted) + margin;
        ReleaseDC(self.content, dc);
        self.height = y;
        self.scroll = self.scroll.clamp(0, (y - viewport.bottom).max(0));
        self.position_content();
        let bw = self.px(128);
        let by = client.bottom - footer + self.px(24);
        MoveWindow(
            self.confirm,
            client.right - margin - bw,
            by,
            bw,
            self.px(40),
            1,
        );
        MoveWindow(
            self.cancel,
            client.right - margin - bw * 2 - self.px(12),
            by,
            bw,
            self.px(40),
            1,
        );
        InvalidateRect(self.window, null(), 0);
        InvalidateRect(self.content, null(), 0);
    }
    unsafe fn position_content(&self) {
        for (hwnd, mut r) in [
            (self.password, self.password_rect),
            (self.key, self.key_rect),
            (self.details, self.details_rect),
        ] {
            if !hwnd.is_null() {
                if hwnd == self.password {
                    InflateRect(&mut r, -self.px(12), -self.px(9));
                }
                MoveWindow(
                    hwnd,
                    r.left,
                    r.top - self.scroll,
                    r.right - r.left,
                    r.bottom - r.top,
                    1,
                );
            }
        }
        InvalidateRect(self.content, null(), 0);
    }
    unsafe fn thumb(&self) -> Option<RECT> {
        let mut view: RECT = zeroed();
        GetClientRect(self.content, &mut view);
        if self.height <= view.bottom {
            return None;
        }
        let track = (view.bottom - self.px(16)).max(1);
        let length = (track * view.bottom / self.height)
            .max(self.px(28))
            .min(track);
        let top = self.px(8) + self.scroll * (track - length) / (self.height - view.bottom);
        Some(rect(view.right - self.px(10), top, self.px(5), length))
    }
    unsafe fn scroll_to(&mut self, y: i32) {
        let mut r: RECT = zeroed();
        GetClientRect(self.content, &mut r);
        self.scroll = y.clamp(0, (self.height - r.bottom).max(0));
        self.position_content();
    }
    unsafe fn reveal_focus(&mut self) {
        let focus = GetFocus();
        for (hwnd, r) in [
            (self.password, self.password_rect),
            (self.key, self.key_rect),
            (self.details, self.details_rect),
        ] {
            if !hwnd.is_null() && focus == hwnd {
                let mut view: RECT = zeroed();
                GetClientRect(self.content, &mut view);
                if r.top < self.scroll {
                    self.scroll_to(r.top - self.px(12));
                } else if r.bottom > self.scroll + view.bottom {
                    self.scroll_to(r.bottom - view.bottom + self.px(12));
                }
            }
        }
    }
    unsafe fn confirm_input(&mut self) {
        if self.reviews[0].needs_secret {
            let checked = (|| {
                let password = input(self.password, 16384)?;
                if self.private_key() {
                    if self.key_material.is_empty() {
                        return Err("请先从剪贴板读取私钥。".into());
                    }
                    crate::protocol::Secrets {
                        password: password.clone(),
                        private_key: self.key_material.clone(),
                    }
                    .validate()?;
                    russh::keys::decode_secret_key(
                        &self.key_material,
                        (!password.is_empty()).then_some(password.as_str()),
                    )
                    .map_err(|_| "私钥格式无效或口令不正确，请检查后重试。")?;
                } else if password.is_empty() {
                    return Err("请输入密码。".into());
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = checked {
                self.error = error;
                self.layout();
                self.scroll_to(self.height);
                SetFocus(if self.private_key() && self.key_material.is_empty() {
                    self.key
                } else {
                    self.password
                });
                return;
            }
        }
        self.accepted = true;
        self.closed = true;
    }
    unsafe fn command(&mut self, id: usize) {
        match id {
            CONFIRM => self.confirm_input(),
            CANCEL => self.closed = true,
            KEY => {
                match clipboard_key(self.window) {
                    Ok(key) => {
                        self.key_material = key;
                        self.error.clear();
                    }
                    Err(error) => self.error = error,
                }
                SetWindowTextW(
                    self.key,
                    wide(if self.key_material.is_empty() {
                        "从剪贴板读取私钥"
                    } else {
                        "重新读取私钥"
                    })
                    .as_ptr(),
                );
                self.layout();
                self.reveal_focus();
            }
            DETAILS => {
                self.expanded = !self.expanded;
                SetWindowTextW(
                    self.details,
                    wide(if self.expanded {
                        "收起确认详情  −"
                    } else {
                        "展开确认详情  +"
                    })
                    .as_ptr(),
                );
                self.layout();
                self.reveal_focus();
            }
            _ => {}
        }
    }
    unsafe fn paint(&self, hwnd: HWND) {
        let mut paint: PAINTSTRUCT = zeroed();
        let target = BeginPaint(hwnd, &mut paint);
        let mut r: RECT = zeroed();
        GetClientRect(hwnd, &mut r);
        let dc = CreateCompatibleDC(target);
        let bitmap = Gdi(CreateCompatibleBitmap(
            target,
            r.right.max(1),
            r.bottom.max(1),
        ));
        let old = SelectObject(dc, bitmap.0);
        fill(dc, &r, self.palette.background);
        if hwnd == self.content {
            if !self.password.is_null() {
                let mut input = self.password_rect;
                OffsetRect(&mut input, 0, -self.scroll);
                rounded(
                    dc,
                    &input,
                    self.palette.input,
                    if GetFocus() == self.password {
                        self.palette.accent
                    } else {
                        self.palette.border
                    },
                    self.px(7),
                );
            }
            if let Some(thumb) = self.thumb() {
                rounded(
                    dc,
                    &thumb,
                    self.palette.muted,
                    self.palette.muted,
                    self.px(5),
                );
            }
            for card in &self.cards {
                let mut area = card.rect;
                OffsetRect(&mut area, 0, -self.scroll);
                if area.bottom >= 0 && area.top < r.bottom {
                    rounded(
                        dc,
                        &area,
                        self.palette.card,
                        self.palette.border,
                        self.px(10),
                    );
                }
            }
            SetBkMode(dc, TRANSPARENT as i32);
            for text in &self.texts {
                let mut area = text.rect;
                OffsetRect(&mut area, 0, -self.scroll);
                if area.bottom < 0 || area.top >= r.bottom {
                    continue;
                }
                let font = SelectObject(dc, self.fonts[text.font].0);
                SetTextColor(dc, self.tone(text.tone));
                let value = wide(&text.value);
                DrawTextW(
                    dc,
                    value.as_ptr(),
                    (value.len() - 1) as i32,
                    &mut area,
                    DT_LEFT | DT_SINGLELINE | DT_NOPREFIX | DT_VCENTER,
                );
                SelectObject(dc, font);
            }
        } else {
            fill(
                dc,
                &rect(0, r.bottom - self.px(FOOTER), r.right, 1),
                self.palette.border,
            );
        }
        BitBlt(target, 0, 0, r.right, r.bottom, dc, 0, 0, SRCCOPY);
        SelectObject(dc, old);
        DeleteDC(dc);
        EndPaint(hwnd, &paint);
    }
    unsafe fn button(&self, item: &DRAWITEMSTRUCT) {
        let primary = item.CtlID == CONFIRM as u32;
        let mut cursor: POINT = zeroed();
        GetCursorPos(&mut cursor);
        ScreenToClient(item.hwndItem, &mut cursor);
        let hover = PtInRect(&item.rcItem, cursor) != 0;
        let active = item.itemState & ODS_SELECTED != 0;
        let bg = if primary {
            if self.dangerous() {
                self.palette.danger
            } else {
                self.palette.accent
            }
        } else if hover || active {
            self.palette.hover
        } else {
            self.palette.card
        };
        let foreground = if primary {
            if self.dangerous() {
                color(if self.theme == Theme::Dark {
                    0x17191b
                } else {
                    0xffffff
                })
            } else {
                self.palette.accent_text
            }
        } else {
            self.palette.text
        };
        fill(item.hDC, &item.rcItem, self.palette.background);
        let mut area = item.rcItem;
        InflateRect(&mut area, -1, -1);
        rounded(
            item.hDC,
            &area,
            bg,
            if primary { bg } else { self.palette.border },
            self.px(7),
        );
        let mut label = [0u16; 128];
        let count = GetWindowTextW(item.hwndItem, label.as_mut_ptr(), 128);
        SetBkMode(item.hDC, TRANSPARENT as i32);
        SetTextColor(item.hDC, foreground);
        let old = SelectObject(item.hDC, self.fonts[4].0);
        if active {
            OffsetRect(&mut area, 0, self.px(1));
        }
        DrawTextW(
            item.hDC,
            label.as_ptr(),
            count,
            &mut area,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );
        if item.itemState & ODS_FOCUS != 0 {
            InflateRect(&mut area, -self.px(4), -self.px(4));
            DrawFocusRect(item.hDC, &area);
        }
        SelectObject(item.hDC, old);
    }
}

unsafe fn fill(dc: HDC, area: &RECT, color: u32) {
    let brush = Gdi(CreateSolidBrush(color));
    FillRect(dc, area, brush.0);
}
unsafe fn rounded(dc: HDC, area: &RECT, background: u32, border: u32, radius: i32) {
    let brush = Gdi(CreateSolidBrush(background));
    let pen = Gdi(CreatePen(PS_SOLID, 1, border));
    let old_brush = SelectObject(dc, brush.0);
    let old_pen = SelectObject(dc, pen.0);
    RoundRect(
        dc,
        area.left,
        area.top,
        area.right,
        area.bottom,
        radius,
        radius,
    );
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
}

// 按实际字形宽度换行，长主机名和无空格指纹也完整显示。
unsafe fn wrap(dc: HDC, value: &str, width: i32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for c in value.chars().filter(|c| *c != '\r') {
        if c == '\n' {
            lines.push(std::mem::take(&mut line));
            continue;
        }
        let mut candidate = line.clone();
        candidate.push(c);
        let utf16 = wide(&candidate);
        let mut size: SIZE = zeroed();
        GetTextExtentPoint32W(dc, utf16.as_ptr(), (utf16.len() - 1) as i32, &mut size);
        if size.cx > width && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
        }
        line.push(c);
    }
    lines.push(line);
    lines
}

unsafe extern "system" fn button_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_MOUSEMOVE {
        let mut tracking = TRACKMOUSEEVENT {
            cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        TrackMouseEvent(&mut tracking);
        InvalidateRect(hwnd, null(), 0);
    } else if msg == WM_MOUSELEAVE || msg == WM_SETFOCUS || msg == WM_KILLFOCUS {
        InvalidateRect(hwnd, null(), 0);
    }
    // 对话导航不能把自绘按钮改回系统默认样式。
    if msg == BM_SETSTYLE {
        return 0;
    }
    let old = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    CallWindowProcW(
        Some(std::mem::transmute::<
            isize,
            unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
        >(old)),
        hwnd,
        msg,
        w,
        l,
    )
}

unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Dialog;
    if pointer.is_null() {
        return DefWindowProcW(hwnd, msg, w, l);
    }
    let form = &mut *pointer;
    match msg {
        #[cfg(feature = "approval-preview")]
        value if value == WM_APP + 101 && form.preview => match w {
            1 => {
                SetWindowTextW(form.password, wide("synthetic-preview-secret").as_ptr());
                form.seeded = input(form.password, 16384)
                    .is_ok_and(|value| value.as_str() == "synthetic-preview-secret");
                if form.private_key() {
                    let generated = russh::keys::PrivateKey::random(
                        &mut rand::rng(),
                        russh::keys::Algorithm::Ed25519,
                    )
                    .and_then(|key| key.encrypt(&mut rand::rng(), "synthetic-preview-secret"))
                    .and_then(|key| key.to_openssh(russh::keys::ssh_key::LineEnding::LF));
                    if let Ok(key) = generated {
                        form.key_material = Zeroizing::new(key.to_string());
                        SetWindowTextW(form.key, wide("重新读取私钥").as_ptr());
                    } else {
                        form.seeded = false;
                    }
                }
                form.error.clear();
                form.layout();
                return 1;
            }
            2 => return audit(hwnd).is_ok() as isize,
            3 => return !form.error.is_empty() as isize,
            4 => return form.seeded as isize,
            5 => {
                SetFocus(if form.password.is_null() {
                    form.confirm
                } else {
                    form.password
                });
                return 1;
            }
            6 => return (GetFocus() == form.cancel) as isize,
            _ => return 0,
        },
        WM_PAINT => {
            form.paint(hwnd);
            return 0;
        }
        WM_ERASEBKGND => return 1,
        WM_CLOSE => {
            form.closed = true;
            return 0;
        }
        WM_COMMAND => {
            if (w >> 16) as u16 == BN_CLICKED as u16 {
                form.command(w & 0xffff);
            }
            if w & 0xffff == PASSWORD {
                InvalidateRect(form.content, null(), 0);
            }
            return 0;
        }
        WM_SIZE if hwnd == form.window => {
            form.layout();
            return 0;
        }
        WM_DPICHANGED if hwnd == form.window && !form.fixed_dpi => {
            form.dpi = (w & 0xffff) as u32;
            form.create_fonts();
            let r = &*(l as *const RECT);
            let monitor = MonitorFromRect(r, MONITOR_DEFAULTTONEAREST);
            let mut monitor_info = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..zeroed()
            };
            GetMonitorInfoW(monitor, &mut monitor_info);
            let work = monitor_info.rcWork;
            let width = (r.right - r.left).min(work.right - work.left - form.px(24));
            let height = (r.bottom - r.top).min(work.bottom - work.top - form.px(32));
            SetWindowPos(
                hwnd,
                null_mut(),
                r.left.clamp(work.left, (work.right - width).max(work.left)),
                r.top.clamp(work.top, (work.bottom - height).max(work.top)),
                width,
                height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            form.layout();
            return 0;
        }
        WM_VSCROLL => {
            let mut view: RECT = zeroed();
            GetClientRect(form.content, &mut view);
            let y = match (w & 0xffff) as i32 {
                SB_LINEUP => form.scroll - form.px(32),
                SB_LINEDOWN => form.scroll + form.px(32),
                SB_PAGEUP => form.scroll - view.bottom,
                SB_PAGEDOWN => form.scroll + view.bottom,
                SB_TOP => 0,
                SB_BOTTOM => form.height,
                _ => form.scroll,
            };
            form.scroll_to(y);
            return 0;
        }
        WM_LBUTTONDOWN if hwnd == form.content => {
            let point = POINT {
                x: (l as u16 as i16) as i32,
                y: ((l >> 16) as u16 as i16) as i32,
            };
            if let Some(thumb) = form.thumb() {
                if point.x >= thumb.left - form.px(6) {
                    if point.y >= thumb.top && point.y <= thumb.bottom {
                        form.drag = Some((point.y, form.scroll));
                        SetCapture(hwnd);
                    } else {
                        let mut view: RECT = zeroed();
                        GetClientRect(hwnd, &mut view);
                        form.scroll_to(
                            form.scroll
                                + if point.y < thumb.top {
                                    -view.bottom
                                } else {
                                    view.bottom
                                },
                        );
                    }
                    return 0;
                }
            }
        }
        WM_MOUSEMOVE if form.drag.is_some() => {
            let (start, scroll) = form.drag.unwrap();
            let mut view: RECT = zeroed();
            GetClientRect(form.content, &mut view);
            if let Some(thumb) = form.thumb() {
                let travel = (view.bottom - form.px(16) - (thumb.bottom - thumb.top)).max(1);
                let delta = ((l >> 16) as u16 as i16) as i32 - start;
                form.scroll_to(
                    scroll
                        + ((delta as i64 * (form.height - view.bottom) as i64) / travel as i64)
                            as i32,
                );
            }
            return 0;
        }
        WM_LBUTTONUP if form.drag.is_some() => {
            form.drag = None;
            ReleaseCapture();
            return 0;
        }
        WM_CAPTURECHANGED => {
            form.drag = None;
            return 0;
        }
        WM_MOUSEWHEEL => {
            form.wheel += ((w >> 16) as u16 as i16) as i32;
            let steps = form.wheel / 120;
            form.wheel %= 120;
            form.scroll_to(form.scroll - steps * form.px(64));
            return 0;
        }
        WM_CTLCOLOREDIT => {
            SetTextColor(w as HDC, form.palette.text);
            SetBkColor(w as HDC, form.palette.input);
            return form.input_brush.0 as isize;
        }
        WM_DRAWITEM => {
            form.button(&*(l as *const DRAWITEMSTRUCT));
            return 1;
        }
        DM_GETDEFID => return ((DC_HASDEFID as usize) << 16 | CONFIRM) as isize,
        _ => {}
    }
    DefWindowProcW(hwnd, msg, w, l)
}

unsafe fn control(parent: HWND, class: &str, text: &str, style: u32, id: usize) -> HWND {
    CreateWindowExW(
        0,
        wide(class).as_ptr(),
        wide(text).as_ptr(),
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | style,
        0,
        0,
        1,
        1,
        parent,
        id as HMENU,
        GetModuleHandleW(null()),
        null(),
    )
}
unsafe fn button(parent: HWND, text: &str, id: usize) -> HWND {
    let hwnd = control(parent, "BUTTON", text, BS_OWNERDRAW as u32, id);
    if !hwnd.is_null() {
        let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, button_proc as *const () as isize);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, old);
    }
    hwnd
}

pub(super) fn show(reviews: Vec<Review>, theme: Theme) -> crate::Result<Option<Secrets>> {
    run(reviews, theme, None, true, None)
}

type PreviewHook = fn(HWND);

fn run(
    reviews: Vec<Review>,
    theme: Theme,
    dpi: Option<u32>,
    protected: bool,
    hook: Option<PreviewHook>,
) -> crate::Result<Option<Secrets>> {
    if reviews.is_empty()
        || reviews.len() > 500
        || (reviews.len() > 1 && reviews.iter().any(|r| r.needs_secret))
    {
        return Err("确认内容无效".into());
    }
    unsafe {
        let previous_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        struct Dpi(DPI_AWARENESS_CONTEXT);
        impl Drop for Dpi {
            fn drop(&mut self) {
                unsafe {
                    if !self.0.is_null() {
                        SetThreadDpiAwarenessContext(self.0);
                    }
                }
            }
        }
        let _dpi = Dpi(previous_dpi);
        let class = wide("FsTTYBrokerApprovalV2");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: GetModuleHandleW(null()),
            lpszClassName: class.as_ptr(),
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            ..zeroed()
        };
        RegisterClassW(&wc);
        let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN;
        let window = CreateWindowExW(
            0,
            class.as_ptr(),
            wide("FsTTY — SSH 凭据安全确认").as_ptr(),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            640,
            700,
            null_mut(),
            null_mut(),
            wc.hInstance,
            null(),
        );
        if window.is_null() {
            return Err("无法创建安全确认窗口".into());
        }
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let owner = Window(window);
        if protected && SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE) == 0 {
            return Err("无法启用安全窗口捕获保护".into());
        }
        let content = CreateWindowExW(
            WS_EX_CONTROLPARENT,
            class.as_ptr(),
            null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            window,
            null_mut(),
            wc.hInstance,
            null(),
        );
        let palette = Palette::from(theme);
        let mut form = Box::new(Dialog {
            window,
            content,
            password: null_mut(),
            key: null_mut(),
            details: button(content, "展开确认详情  +", DETAILS),
            cancel: button(window, "取消", CANCEL),
            confirm: button(window, action(&reviews), CONFIRM),
            account: if protected {
                account_name(&reviews[0].owner_sid)
            } else {
                "FsTTY 测试用户".into()
            },
            reviews,
            theme,
            input_brush: Gdi(CreateSolidBrush(palette.input)),
            palette,
            fonts: vec![],
            texts: vec![],
            cards: vec![],
            key_material: Zeroizing::new(String::new()),
            error: String::new(),
            expanded: false,
            accepted: false,
            closed: false,
            dpi: dpi.unwrap_or_else(|| GetDpiForWindow(window)).max(96),
            fixed_dpi: dpi.is_some(),
            scroll: 0,
            height: 0,
            password_rect: zeroed(),
            key_rect: zeroed(),
            details_rect: zeroed(),
            wheel: 0,
            drag: None,
            #[cfg(feature = "approval-preview")]
            preview: !protected,
            #[cfg(feature = "approval-preview")]
            seeded: false,
        });
        if form.reviews[0].needs_secret {
            if form.private_key() {
                form.key = button(content, "从剪贴板读取私钥", KEY);
            }
            form.password = control(
                content,
                "EDIT",
                "",
                ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
                PASSWORD,
            );
            SendMessageW(form.password, EM_SETLIMITTEXT, 16384, 0);
            SendMessageW(
                form.password,
                EM_SETMARGINS,
                (EC_LEFTMARGIN | EC_RIGHTMARGIN) as usize,
                form.px(10) as isize | ((form.px(10) as isize) << 16),
            );
            let old = SetWindowLongPtrW(
                form.password,
                GWLP_WNDPROC,
                secret_procedure as *const () as isize,
            );
            SetWindowLongPtrW(form.password, GWLP_USERDATA, old);
        }
        if [content, form.details, form.confirm, form.cancel]
            .iter()
            .any(|h| h.is_null())
            || (form.reviews[0].needs_secret && form.password.is_null())
            || (form.reviews[0].needs_secret && form.private_key() && form.key.is_null())
        {
            drop(owner);
            return Err("无法创建安全窗口控件".into());
        }
        form.create_fonts();
        let pointer = (&mut *form as *mut Dialog) as isize;
        SetWindowLongPtrW(window, GWLP_USERDATA, pointer);
        SetWindowLongPtrW(content, GWLP_USERDATA, pointer);
        let dark = if theme == Theme::Dark { 1i32 } else { 0 };
        DwmSetWindowAttribute(
            window,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&dark as *const i32).cast(),
            4,
        );
        let mut point: POINT = zeroed();
        GetCursorPos(&mut point);
        let monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..zeroed()
        };
        GetMonitorInfoW(monitor, &mut info);
        let available = info.rcWork;
        let mut bounds = rect(0, 0, form.px(640), form.px(600));
        AdjustWindowRectExForDpi(&mut bounds, style, 0, 0, form.dpi);
        let width =
            (bounds.right - bounds.left).min(available.right - available.left - form.px(24));
        SetWindowPos(
            window,
            null_mut(),
            0,
            0,
            width,
            form.px(600),
            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        form.layout();
        let chrome = (bounds.bottom - bounds.top) - form.px(600);
        let height = (form.height + form.px(FOOTER) + chrome)
            .min(available.bottom - available.top - form.px(32));
        SetWindowPos(
            window,
            null_mut(),
            available.left + (available.right - available.left - width) / 2,
            available.top + (available.bottom - available.top - height) / 2,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        form.layout();
        ShowWindow(window, SW_SHOW);
        UpdateWindow(window);
        let mut viewport: RECT = zeroed();
        GetClientRect(content, &mut viewport);
        SetFocus(
            if !form.password.is_null() && form.password_rect.bottom <= viewport.bottom {
                form.password
            } else if !form.password.is_null() {
                form.details
            } else {
                form.cancel
            },
        );
        if let Some(hook) = hook {
            hook(window);
        }
        let mut message: MSG = zeroed();
        while !form.closed {
            let result = GetMessageW(&mut message, null_mut(), 0, 0);
            if result <= 0 {
                break;
            }
            if message.message == WM_KEYDOWN && message.wParam == VK_ESCAPE as usize {
                form.closed = true;
                continue;
            }
            if message.message == WM_KEYDOWN
                && message.wParam == VK_RETURN as usize
                && GetFocus() == form.password
            {
                form.confirm_input();
                continue;
            }
            if message.message == WM_KEYDOWN && GetFocus() != form.password {
                let code = match message.wParam as u16 {
                    VK_PRIOR => Some(SB_PAGEUP),
                    VK_NEXT => Some(SB_PAGEDOWN),
                    VK_HOME => Some(SB_TOP),
                    VK_END => Some(SB_BOTTOM),
                    _ => None,
                };
                if let Some(code) = code {
                    SendMessageW(form.content, WM_VSCROLL, code as usize, 0);
                    continue;
                }
            }
            let previous_focus = GetFocus();
            if IsDialogMessageW(window, &message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if previous_focus != GetFocus() {
                form.reveal_focus();
            }
        }
        let result = if !form.accepted {
            Err("用户已取消安全确认".into())
        } else if form.reviews[0].needs_secret {
            input(form.password, 16384).map(|password| {
                Some(Secrets {
                    password,
                    private_key: std::mem::take(&mut form.key_material),
                })
            })
        } else {
            Ok(None)
        };
        if !form.password.is_null() {
            SetWindowTextW(form.password, wide("").as_ptr());
        }
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        SetWindowLongPtrW(content, GWLP_USERDATA, 0);
        drop(owner);
        drop(form);
        result
    }
}

#[cfg(feature = "approval-preview")]
pub(super) fn preview(
    reviews: Vec<Review>,
    theme: Theme,
    dpi: u32,
    hook: Option<PreviewHook>,
) -> crate::Result<()> {
    // 此入口只供不连接服务的合成数据预览；正式安装包不启用该构建特性。
    let _ = run(reviews, theme, Some(dpi), false, hook)?;
    Ok(())
}

#[cfg(feature = "approval-preview")]
pub(super) unsafe fn audit(window: HWND) -> crate::Result<()> {
    let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const Dialog;
    let form = pointer.as_ref().ok_or("预览窗口不存在")?;
    let mut area: RECT = zeroed();
    GetClientRect(form.content, &mut area);
    for text in &form.texts {
        if text.rect.left < 0 || text.rect.right > area.right || text.rect.bottom > form.height {
            return Err("文本超出布局边界".into());
        }
    }
    for pair in form.cards.windows(2) {
        if pair[0].rect.bottom >= pair[1].rect.top {
            return Err("会话卡片重叠".into());
        }
    }
    let mut outer: RECT = zeroed();
    GetClientRect(window, &mut outer);
    for button in [form.cancel, form.confirm] {
        let mut r: RECT = zeroed();
        GetWindowRect(button, &mut r);
        MapWindowPoints(null_mut(), window, (&mut r as *mut RECT).cast(), 2);
        if r.top < area.bottom || r.bottom > outer.bottom || r.left < 0 || r.right > outer.right {
            return Err("底部按钮被遮挡".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(change: Change, import: bool) -> Review {
        Review {
            target: None,
            owner_sid: "S-1-5-21-1".into(),
            change,
            revision: 1,
            old_fingerprint: String::new(),
            fingerprint: String::new(),
            needs_secret: false,
            import,
        }
    }
    #[test]
    fn 删除和混合批次必须明确显示实际操作() {
        let delete = fixture(Change::Delete { id: "test".into() }, false);
        let import = fixture(
            Change::Configure {
                target: crate::protocol::Target {
                    id: "test2".into(),
                    host: "example.test".into(),
                    port: 22,
                    username: "test".into(),
                    private_key: false,
                },
                replace_secret: true,
            },
            true,
        );
        assert_eq!(action(std::slice::from_ref(&delete)), "删除凭据");
        assert_eq!(action(std::slice::from_ref(&import)), "迁移凭据");
        assert_eq!(action(&[import, delete]), "确认凭据变更");
        assert_eq!(
            action(&[fixture(Change::Trust { id: "test".into() }, false)]),
            "信任此主机"
        );
    }
    #[test]
    fn 指纹与长地址换行不得截断或改变内容() {
        unsafe {
            let dc = CreateCompatibleDC(null_mut());
            assert!(!dc.is_null());
            for value in [
                "SHA256:Zx5Xn38lmgUQ6eWTpRvy0qM2h3C1B6NfHkSzJuDaL9E".to_owned(),
                "very-long-host-".repeat(16),
                "含中文的服务器.example.test".into(),
            ] {
                let lines = wrap(dc, &value, 80);
                assert!(lines.len() > 1);
                assert_eq!(lines.concat(), value);
                for line in lines {
                    let units = wide(&line);
                    let mut size: SIZE = zeroed();
                    GetTextExtentPoint32W(dc, units.as_ptr(), (units.len() - 1) as i32, &mut size);
                    assert!(size.cx <= 80);
                }
            }
            DeleteDC(dc);
        }
    }
}
