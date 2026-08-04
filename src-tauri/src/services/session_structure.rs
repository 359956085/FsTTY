use crate::models::StoredSession;
use std::collections::HashSet;

pub(super) const DEFAULT_SESSION_GROUP: &str = "未分组";

pub(super) fn group_session_blocks(
    sessions: &[StoredSession],
) -> Vec<(String, Vec<StoredSession>)> {
    let mut groups = Vec::<(String, Vec<StoredSession>)>::new();
    for session in sessions {
        if let Some((_, group_sessions)) =
            groups.iter_mut().find(|(name, _)| name == &session.group)
        {
            group_sessions.push(session.clone());
        } else {
            groups.push((session.group.clone(), vec![session.clone()]));
        }
    }
    groups
}

pub(super) fn flatten_session_blocks(
    groups: Vec<(String, Vec<StoredSession>)>,
) -> Vec<StoredSession> {
    groups
        .into_iter()
        .flat_map(|(_, sessions)| sessions)
        .collect()
}

pub(super) fn normalize_group(group: &str) -> String {
    let group = group.trim();
    if group.is_empty() {
        DEFAULT_SESSION_GROUP.to_owned()
    } else {
        group.to_owned()
    }
}

pub(super) fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .map(|tag| tag.trim().to_owned())
        .filter(|tag| !tag.is_empty() && seen.insert(tag.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 标签保持顺序并忽略大小写去重() {
        assert_eq!(
            normalize_tags(vec![
                " Prod ".to_owned(),
                "prod".to_owned(),
                "SSH".to_owned()
            ]),
            vec!["Prod".to_owned(), "SSH".to_owned()]
        );
    }

    #[test]
    fn 空分组回退默认分组() {
        assert_eq!(normalize_group("  "), DEFAULT_SESSION_GROUP);
        assert_eq!(normalize_group(" prod "), "prod");
    }
}
