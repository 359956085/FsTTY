use axum::http::{header, HeaderMap, HeaderValue};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ByteRange {
    pub(super) offset: u64,
    pub(super) length: u64,
}

pub(super) fn parse_range_headers(headers: &HeaderMap, size: u64) -> Result<Option<ByteRange>, ()> {
    let mut values = headers.get_all(header::RANGE).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(());
    }
    parse_range(first, size)
}

pub(super) fn parse_range(value: Option<&HeaderValue>, size: u64) -> Result<Option<ByteRange>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if size == 0 {
        return Err(());
    }
    let value = value.to_str().map_err(|_| ())?;
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(',') {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(size);
        return Ok(Some(ByteRange {
            offset: size - length,
            length,
        }));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some(ByteRange {
        offset: start,
        length: end - start + 1,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析完整开放和后缀区间() {
        assert_eq!(
            parse_range(Some(&HeaderValue::from_static("bytes=0-9")), 100),
            Ok(Some(ByteRange {
                offset: 0,
                length: 10
            }))
        );
        assert_eq!(
            parse_range(Some(&HeaderValue::from_static("bytes=90-")), 100),
            Ok(Some(ByteRange {
                offset: 90,
                length: 10
            }))
        );
        assert_eq!(
            parse_range(Some(&HeaderValue::from_static("bytes=-10")), 100),
            Ok(Some(ByteRange {
                offset: 90,
                length: 10
            }))
        );
    }
}
