use super::{AppError, FileKind};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPatch {
    pub mask: u32,
    pub value: u32,
}
impl PermissionPatch {
    pub fn validate(self) -> Result<(), AppError> {
        if (self.mask | self.value) & !0o777 != 0 || self.value & !self.mask != 0 {
            return Err(AppError::Validation("权限修改值无效".into()));
        }
        Ok(())
    }
    pub fn apply(self, mode: u32) -> Result<u32, AppError> {
        self.validate()?;
        Ok(((mode & !self.mask) | self.value) & 0o7777)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePermissionEntry {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub mode: Option<u32>,
    pub size: u64,
    pub owner: String,
    pub group: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUploadEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUploadLocation {
    pub label: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUploadDirectory {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<LocalUploadEntry>,
    pub truncated: bool,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patches_keep_untouched_and_special_bits() {
        assert_eq!(
            PermissionPatch {
                mask: 0o020,
                value: 0o020
            }
            .apply(0o4755)
            .unwrap(),
            0o4775
        );
        assert_eq!(
            PermissionPatch {
                mask: 0o777,
                value: 0o640
            }
            .apply(0o2755)
            .unwrap(),
            0o2640
        );
        assert!(PermissionPatch {
            mask: 0o7777,
            value: 0
        }
        .validate()
        .is_err());
        assert!(PermissionPatch {
            mask: 0o020,
            value: 0o040
        }
        .validate()
        .is_err());
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUploadLocations {
    pub locations: Vec<LocalUploadLocation>,
    pub initial_path: Option<String>,
}
