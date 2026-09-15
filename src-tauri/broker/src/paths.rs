use crate::windows::{security_descriptor, wide, Handle, Local};
use std::{path::Path, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
};

fn sid_text(sid: PSID) -> crate::Result<String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err("无法验证目录所有者".into());
    }
    let memory = Local(text.cast());
    let mut n = 0;
    unsafe {
        while *text.add(n) != 0 {
            n += 1;
        }
    }
    let result = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, n) });
    drop(memory);
    Ok(result)
}

fn trusted(sid: &str, service_sid: &str) -> bool {
    sid == "S-1-5-18"
        || sid == "S-1-5-32-544"
        || sid == service_sid
        || sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
}

// 父目录验证后才检查子项；受保护父目录阻止普通用户在检查后替换子项。
pub fn verify(path: &Path, service_sid: &str, secret: bool) -> crate::Result<()> {
    let path_text = wide(&path.to_string_lossy());
    let handle = Handle(unsafe {
        CreateFileW(
            path_text.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    });
    if handle.0 == INVALID_HANDLE_VALUE {
        return Err("无法验证受保护路径".into());
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.nNumberOfLinks > 1
    {
        return Err("服务路径不能包含重解析点或硬链接".into());
    }
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    if unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    } != ERROR_SUCCESS
    {
        return Err("无法验证服务路径权限".into());
    }
    let _memory = Local(descriptor);
    if owner.is_null() || acl.is_null() || !trusted(&sid_text(owner)?, service_sid) {
        return Err("服务路径由不受信任账号拥有，请由管理员修复安装目录".into());
    }
    let dangerous = if secret { 0xf00001ff } else { 0x500d0156 };
    for index in 0..unsafe { (*acl).AceCount as u32 } {
        let mut ace = null_mut();
        if unsafe { GetAce(acl, index, &mut ace) } == 0 {
            return Err("路径访问控制项无效".into());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }
        if header.AceType == 1 {
            continue;
        }
        if header.AceType != 0 {
            return Err("服务目录包含不支持的访问控制项".into());
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = sid_text((&allowed.SidStart as *const u32).cast_mut().cast())?;
        if !trusted(&sid, service_sid) && allowed.Mask & dangerous != 0 {
            return Err("普通账号仍可访问服务受保护数据或修改程序，请修复目录权限".into());
        }
    }
    Ok(())
}

pub fn verify_tree(path: &Path, sid: &str, secret: bool) -> crate::Result<()> {
    verify(path, sid, secret)?;
    if path.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|_| "无法检查服务目录")? {
            verify_tree(&entry.map_err(|_| "无法检查服务文件")?.path(), sid, secret)?;
        }
    }
    Ok(())
}

pub fn create_data_dir(path: &Path, sid: &str) -> crate::Result<()> {
    let sd = security_descriptor(&format!(
        "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})"
    ))?;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(&path.to_string_lossy()).as_ptr(), &sa) } == 0
        && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
    {
        return Err("无法创建受保护服务目录".into());
    }
    verify_tree(path, sid, true)
}
