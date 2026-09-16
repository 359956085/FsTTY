#[cfg(windows)]
pub mod admin;
#[cfg(windows)]
pub mod installation;
#[cfg(windows)]
pub mod paths;
pub mod protocol;
pub mod proxy;
#[cfg(windows)]
pub mod service;
pub mod store;
#[cfg(windows)]
pub mod update;
#[cfg(windows)]
pub mod windows;

pub type Result<T> = std::result::Result<T, String>;
