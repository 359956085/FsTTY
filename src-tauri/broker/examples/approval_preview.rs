#[cfg(windows)]
mod preview {
    use fstty_broker::admin::{preview, Theme};
    use std::{
        mem::{size_of, zeroed},
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            OnceLock,
        },
    };
    use windows_sys::Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    static OUTPUT: OnceLock<PathBuf> = OnceLock::new();
    static PASSED: AtomicBool = AtomicBool::new(false);
    static ACCEPT: AtomicBool = AtomicBool::new(false);

    fn capture(hwnd: HWND, path: &std::path::Path) -> Result<(), String> {
        unsafe {
            let mut r: RECT = zeroed();
            GetWindowRect(hwnd, &mut r);
            let width = r.right - r.left;
            let height = r.bottom - r.top;
            let screen = GetWindowDC(hwnd);
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let old = SelectObject(dc, bitmap);
            let printed = windows_sys::Win32::Storage::Xps::PrintWindow(hwnd, dc, 2);
            SelectObject(dc, old);
            let mut info: BITMAPINFO = zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..zeroed()
            };
            let mut data = vec![0u8; (width * height * 4) as usize];
            let rows = GetDIBits(
                dc,
                bitmap,
                0,
                height as u32,
                data.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            );
            DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(hwnd, screen);
            if printed == 0 || rows == 0 {
                return Err("预览截图失败".into());
            }
            let mut bmp = Vec::new();
            bmp.extend_from_slice(b"BM");
            bmp.extend_from_slice(&((54 + data.len()) as u32).to_le_bytes());
            bmp.extend_from_slice(&[0; 4]);
            bmp.extend_from_slice(&54u32.to_le_bytes());
            bmp.extend_from_slice(&40u32.to_le_bytes());
            bmp.extend_from_slice(&width.to_le_bytes());
            bmp.extend_from_slice(&(-height).to_le_bytes());
            bmp.extend_from_slice(&1u16.to_le_bytes());
            bmp.extend_from_slice(&32u16.to_le_bytes());
            bmp.extend_from_slice(&[0; 24]);
            bmp.extend_from_slice(&data);
            std::fs::write(path, bmp).map_err(|_| "无法写入预览截图")?;
            Ok(())
        }
    }

    fn hook(window: HWND) {
        unsafe {
            preview::audit(window).expect("预览布局应有效");
        }
        let window = window as usize;
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(|| unsafe {
                let hwnd = window as HWND;
                std::thread::sleep(std::time::Duration::from_millis(250));
                let output = OUTPUT.get().unwrap();
                capture(hwnd, output).expect("应生成初始窗口截图");
                SendMessageW(hwnd, WM_COMMAND, 5, 0);
                assert_eq!(
                    SendMessageW(hwnd, WM_APP + 101, 2, 0),
                    1,
                    "展开详情后的布局应有效"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
                capture(hwnd, &output.with_extension("details.bmp")).expect("应生成详情截图");
                SendMessageW(hwnd, WM_COMMAND, 5, 0);
                let content = GetWindow(hwnd, GW_CHILD);
                let password = GetDlgItem(content, 3);
                if !password.is_null() {
                    SendMessageW(hwnd, WM_COMMAND, 1, 0);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    capture(hwnd, &output.with_extension("validation.bmp"))
                        .expect("应生成必填提示截图");
                    assert_eq!(
                        SendMessageW(hwnd, WM_APP + 101, 3, 0),
                        1,
                        "空凭据应显示就地提示"
                    );
                    PostMessageW(hwnd, WM_APP + 101, 1, 0);
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    assert_eq!(
                        SendMessageW(hwnd, WM_APP + 101, 4, 0),
                        1,
                        "应已填入专用测试秘密"
                    );
                    let mut buffer = [0u16; 32];
                    assert_eq!(
                        SendMessageW(password, WM_GETTEXT, 32, buffer.as_mut_ptr() as isize),
                        0,
                        "跨线程不能读取密码控件"
                    );
                    assert_eq!(
                        SendMessageW(password, WM_GETOBJECT, 0, 0),
                        0,
                        "不能通过辅助功能读取秘密"
                    );
                    SendMessageW(hwnd, WM_APP + 101, 5, 0);
                    PostMessageW(password, WM_KEYDOWN, 0x09, 0);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    assert_eq!(
                        SendMessageW(hwnd, WM_APP + 101, 6, 0),
                        1,
                        "Tab 应从输入框进入取消按钮"
                    );
                }
                SendMessageW(content, WM_VSCROLL, SB_BOTTOM as usize, 0);
                std::thread::sleep(std::time::Duration::from_millis(100));
                capture(hwnd, &output.with_extension("bottom.bmp")).expect("应生成底部截图");
                assert_eq!(
                    SendMessageW(hwnd, WM_APP + 101, 2, 0),
                    1,
                    "滚动后的布局应有效"
                );
                if ACCEPT.load(Ordering::Acquire) {
                    SendMessageW(hwnd, WM_APP + 101, 5, 0);
                }
            });
            PASSED.store(result.is_ok(), Ordering::Release);
            unsafe {
                PostMessageW(
                    window as HWND,
                    WM_KEYDOWN,
                    if result.is_ok() && ACCEPT.load(Ordering::Acquire) {
                        0x0d
                    } else {
                        0x1b
                    },
                    0,
                );
                std::thread::sleep(std::time::Duration::from_secs(2));
                if IsWindow(window as HWND) != 0 {
                    PASSED.store(false, Ordering::Release);
                    PostMessageW(window as HWND, WM_CLOSE, 0, 0);
                }
            }
        });
    }

    pub fn run() -> Result<(), String> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.len() < 3 || args.len() > 4 {
            return Err("参数：场景 light|dark 96|144|192 [截图路径.bmp]".into());
        }
        let theme = Theme::parse(&args[1])?;
        let dpi = args[2].parse().map_err(|_| "DPI 无效")?;
        ACCEPT.store(
            matches!(args[0].as_str(), "password" | "key" | "long" | "migrate"),
            Ordering::Release,
        );
        let automated = args.get(3).map(|path| {
            OUTPUT.set(PathBuf::from(path)).unwrap();
            hook as fn(HWND)
        });
        let result = match preview::show(&args[0], theme, dpi, automated) {
            Err(error)
                if error == "用户已取消安全确认"
                    && (automated.is_none() || !ACCEPT.load(Ordering::Acquire)) =>
            {
                Ok(())
            }
            other => other,
        };
        result?;
        if automated.is_some() && !PASSED.load(Ordering::Acquire) {
            return Err("预览自动检查失败".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    if let Err(error) = preview::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    eprintln!("预览仅支持 Windows");
}
