use semver::Version;

// Older Windows product resources represented stable versions as X.Y.Z.0.
pub(crate) fn parse_product_version(text: &str) -> crate::Result<Version> {
    let normalized = text
        .strip_suffix(".0")
        .filter(|_| {
            text.split('.').count() == 4
                && text
                    .split('.')
                    .all(|part| part.bytes().all(|b| b.is_ascii_digit()))
        })
        .unwrap_or(text);
    let version = Version::parse(normalized).map_err(|_| "程序版本格式无效")?;
    let supported = version.pre.is_empty()
        || version.pre.as_str().strip_prefix("beta.").is_some_and(|n| {
            !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
        });
    if !supported || !version.build.is_empty() {
        return Err("程序版本格式无效".into());
    }
    Ok(version)
}

pub(crate) fn matches_numeric(product: &str, numeric: [u32; 4]) -> crate::Result<bool> {
    let version = parse_product_version(product)?;
    Ok([version.major, version.minor, version.patch, 0] == numeric.map(u64::from))
}

pub(crate) fn is_online_upgrade(current: &str, target: &str) -> crate::Result<bool> {
    let current = parse_product_version(current)?;
    let target = parse_product_version(target)?;
    Ok(target.pre.is_empty() && target > current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beta_order_and_legacy_resources() {
        assert_eq!(
            parse_product_version("2.0.0.0").unwrap(),
            parse_product_version("2.0.0").unwrap()
        );
        assert!(
            parse_product_version("2.1.0-beta.10").unwrap()
                > parse_product_version("2.1.0-beta.2").unwrap()
        );
        assert!(
            parse_product_version("2.1.0").unwrap()
                > parse_product_version("2.1.0-beta.10").unwrap()
        );
        for invalid in [
            "2.1.0-beta",
            "2.1.0-beta.0",
            "2.1.0-beta.01",
            "2.1.0-rc.1",
            "2.1.0+test",
            "2.1.0.1",
        ] {
            assert!(parse_product_version(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn online_updates_require_a_newer_stable_product() {
        for (current, target, expected) in [
            ("2.1.0-beta.1", "2.1.0", true),
            ("2.1.0-beta.1", "2.0.0", false),
            ("2.1.0-beta.1", "2.1.0-beta.2", false),
            ("2.1.0", "2.1.0", false),
            ("2.1.0", "2.2.0", true),
        ] {
            assert_eq!(is_online_upgrade(current, target).unwrap(), expected);
        }
    }

    #[test]
    fn numeric_and_product_versions_must_match() {
        assert!(matches_numeric("2.1.0-beta.1", [2, 1, 0, 0]).unwrap());
        assert!(matches_numeric("2.1.0.0", [2, 1, 0, 0]).unwrap());
        assert!(!matches_numeric("2.1.0-beta.1", [2, 0, 0, 0]).unwrap());
        assert!(!matches_numeric("2.1.0", [2, 1, 0, 1]).unwrap());
    }
}
