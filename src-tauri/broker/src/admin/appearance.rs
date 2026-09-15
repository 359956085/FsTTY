use crate::windows::wide;
use windows_sys::Win32::System::Registry::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub fn parse(value: &str) -> crate::Result<Self> {
        match value {
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            _ => Err("确认窗口主题无效".into()),
        }
    }

    pub fn argument(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn system() -> Self {
        let mut light = 1u32;
        let mut size = 4;
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize").as_ptr(),
                wide("AppsUseLightTheme").as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut light as *mut u32).cast(),
                &mut size,
            );
        }
        if light == 0 {
            Self::Dark
        } else {
            Self::Light
        }
    }
}

pub fn color(hex: u32) -> u32 {
    ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff)
}

pub struct Palette {
    pub background: u32,
    pub card: u32,
    pub input: u32,
    pub border: u32,
    pub text: u32,
    pub muted: u32,
    pub accent: u32,
    pub accent_text: u32,
    pub danger: u32,
    pub warning: u32,
    pub hover: u32,
}

impl From<Theme> for Palette {
    fn from(theme: Theme) -> Self {
        let values = match theme {
            Theme::Dark => [
                0x151719, 0x1c1e20, 0x111315, 0x353a3f, 0xe1e4e7, 0x92989e, 0xb9c0c6, 0x111315,
                0xff6b6b, 0xffad25, 0x2b3035,
            ],
            Theme::Light => [
                0xf7f9fb, 0xffffff, 0xffffff, 0xdce1e6, 0x17212b, 0x687583, 0x287fd6, 0xffffff,
                0xcf3f4b, 0x9a6500, 0xeaf0f6,
            ],
        }
        .map(color);
        let [background, card, input, border, text, muted, accent, accent_text, danger, warning, hover] =
            values;
        Self {
            background,
            card,
            input,
            border,
            text,
            muted,
            accent,
            accent_text,
            danger,
            warning,
            hover,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 主题参数仅接受固定外观枚举() {
        assert_eq!(Theme::parse("dark").unwrap(), Theme::Dark);
        assert_eq!(Theme::parse("light").unwrap(), Theme::Light);
        for invalid in ["system", "dark --service", "", "C:/theme.css"] {
            assert!(Theme::parse(invalid).is_err());
        }
    }
}
