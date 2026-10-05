use super::windows::Handle;
use std::{
    io::{self, Read, Write},
    mem::zeroed,
    os::windows::io::AsRawHandle,
    ptr::{null, null_mut},
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{Threading::CreateEventW, IO::*},
};

// Duplicate synchronous pipe handles share the same file-object lock. A blocked
// read can therefore prevent writes on another thread. Each operation here owns
// its own OVERLAPPED and event, while the duplex handle is opened overlapped.
#[derive(Clone)]
pub(super) struct DuplexPipe(Arc<Handle>);
impl DuplexPipe {
    pub fn connect(name: &str) -> io::Result<Self> {
        let raw = unsafe {
            CreateFileW(
                super::windows::wide(name).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(Arc::new(Handle(raw))))
    }
    fn transfer(&self, start: impl FnOnce(*mut OVERLAPPED) -> i32) -> io::Result<usize> {
        let event = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
        if event.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut operation: OVERLAPPED = unsafe { zeroed() };
        operation.hEvent = event.0;
        if start(&mut operation) == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        let mut transferred = 0;
        // Keep the buffer, event and operation alive until Windows has finished
        // the I/O, including when the other endpoint closes or cancels it.
        if unsafe { GetOverlappedResult(self.0 .0, &operation, &mut transferred, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(transferred as usize)
    }
}
impl AsRawHandle for DuplexPipe {
    fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0 .0
    }
}
impl Read for DuplexPipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let size = buffer.len().min(u32::MAX as usize) as u32;
        self.transfer(|operation| unsafe {
            ReadFile(self.0 .0, buffer.as_mut_ptr(), size, null_mut(), operation)
        })
    }
}
impl Write for DuplexPipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let size = buffer.len().min(u32::MAX as usize) as u32;
        self.transfer(|operation| unsafe {
            WriteFile(self.0 .0, buffer.as_ptr(), size, null_mut(), operation)
        })
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
