pub(super) const MAX_COMMAND_SEGMENTS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UnsupportedShellSyntaxKind {
    CommandSubstitution,
    ProcessSubstitution,
    ArithmeticExpansion,
    Subshell,
    CommandGroup,
    FunctionDefinition,
    CompoundCommand,
    HereDocument,
    MalformedSyntax,
    SegmentLimit,
}

impl UnsupportedShellSyntaxKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::CommandSubstitution => "commandSubstitution",
            Self::ProcessSubstitution => "processSubstitution",
            Self::ArithmeticExpansion => "arithmeticExpansion",
            Self::Subshell => "subshell",
            Self::CommandGroup => "commandGroup",
            Self::FunctionDefinition => "functionDefinition",
            Self::CompoundCommand => "compoundCommand",
            Self::HereDocument => "hereDocument",
            Self::MalformedSyntax => "malformedSyntax",
            Self::SegmentLimit => "segmentLimit",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuoteState {
    None,
    Single,
    Double,
    AnsiC,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorKind {
    Binary,
    Terminator,
    Newline,
}

pub(crate) fn split_simple_command_chain(
    command: &str,
) -> Result<Vec<String>, UnsupportedShellSyntaxKind> {
    let bytes = command.as_bytes();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote = QuoteState::None;
    let mut index = 0;
    let mut needs_operand = false;
    let mut word_start = true;

    while index < bytes.len() {
        if bytes[index].is_ascii_control() && !matches!(bytes[index], b'\n' | b'\t' | b'\r') {
            return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
        }
        match quote {
            QuoteState::Single => {
                push_char(command, &mut index, &mut current);
                if bytes[index - 1] == b'\'' {
                    quote = QuoteState::None;
                }
                continue;
            }
            QuoteState::Double | QuoteState::AnsiC => {
                if bytes[index] == b'\\' {
                    push_escaped(command, &mut index, &mut current)?;
                    continue;
                }
                if quote == QuoteState::Double {
                    reject_expansion(bytes, index)?;
                    if bytes[index] == b'`' {
                        return Err(UnsupportedShellSyntaxKind::CommandSubstitution);
                    }
                    if bytes[index..].starts_with(b"${") {
                        let end = consume_parameter_expansion(command, index)?;
                        current.push_str(&command[index..end]);
                        index = end;
                        continue;
                    }
                }
                let closing = if quote == QuoteState::Double {
                    b'"'
                } else {
                    b'\''
                };
                push_char(command, &mut index, &mut current);
                if bytes[index - 1] == closing {
                    quote = QuoteState::None;
                }
                continue;
            }
            QuoteState::None => {}
        }

        reject_expansion(bytes, index)?;
        match bytes[index] {
            b'\\' => {
                push_escaped(command, &mut index, &mut current)?;
                word_start = false;
            }
            b'$' if bytes[index..].starts_with(b"$'") => {
                current.push_str("$'");
                index += 2;
                quote = QuoteState::AnsiC;
                word_start = false;
            }
            b'$' if bytes[index..].starts_with(b"${") => {
                let end = consume_parameter_expansion(command, index)?;
                current.push_str(&command[index..end]);
                index = end;
                word_start = false;
            }
            b'\'' => {
                current.push('\'');
                index += 1;
                quote = QuoteState::Single;
                word_start = false;
            }
            b'"' => {
                current.push('"');
                index += 1;
                quote = QuoteState::Double;
                word_start = false;
            }
            b'`' => return Err(UnsupportedShellSyntaxKind::CommandSubstitution),
            b'<' if bytes[index..].starts_with(b"<<") => {
                return Err(UnsupportedShellSyntaxKind::HereDocument);
            }
            b'<' | b'>' if bytes.get(index + 1) == Some(&b'(') => {
                return Err(UnsupportedShellSyntaxKind::ProcessSubstitution);
            }
            b'(' if bytes[index..].starts_with(b"((") => {
                return Err(UnsupportedShellSyntaxKind::ArithmeticExpansion);
            }
            b'(' if looks_like_function_definition(&current, bytes, index) => {
                return Err(UnsupportedShellSyntaxKind::FunctionDefinition);
            }
            b'(' | b')' => return Err(UnsupportedShellSyntaxKind::Subshell),
            b'{' | b'}' => return Err(UnsupportedShellSyntaxKind::CommandGroup),
            b'#' if word_start => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b';' if matches!(bytes.get(index + 1), Some(b';' | b'&')) => {
                return Err(UnsupportedShellSyntaxKind::CompoundCommand);
            }
            b';' => {
                consume_operator(
                    &mut current,
                    &mut segments,
                    &mut needs_operand,
                    OperatorKind::Terminator,
                )?;
                index += 1;
                word_start = true;
            }
            b'&' if is_redirection_ampersand(bytes, index, &current) => {
                current.push('&');
                index += 1;
                word_start = false;
            }
            b'&' => {
                let kind = if bytes.get(index + 1) == Some(&b'&') {
                    index += 2;
                    OperatorKind::Binary
                } else {
                    index += 1;
                    OperatorKind::Terminator
                };
                consume_operator(&mut current, &mut segments, &mut needs_operand, kind)?;
                word_start = true;
            }
            b'|' if current.as_bytes().last() == Some(&b'>') => {
                current.push('|');
                index += 1;
                word_start = false;
            }
            b'|' => {
                let advance = if matches!(bytes.get(index + 1), Some(b'|' | b'&')) {
                    2
                } else {
                    1
                };
                consume_operator(
                    &mut current,
                    &mut segments,
                    &mut needs_operand,
                    OperatorKind::Binary,
                )?;
                index += advance;
                word_start = true;
            }
            b'\n' => {
                consume_operator(
                    &mut current,
                    &mut segments,
                    &mut needs_operand,
                    OperatorKind::Newline,
                )?;
                index += 1;
                word_start = true;
            }
            _ => {
                let value = command[index..].chars().next().expect("索引应位于字符边界");
                if value.is_control() && !matches!(value, '\t' | '\r') {
                    return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
                }
                word_start = value.is_whitespace();
                current.push(value);
                index += value.len_utf8();
            }
        }
    }

    if quote != QuoteState::None {
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    if !current.trim().is_empty() {
        push_segment(&mut current, &mut segments)?;
        needs_operand = false;
    }
    if needs_operand || segments.is_empty() {
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    Ok(segments)
}

fn consume_operator(
    current: &mut String,
    segments: &mut Vec<String>,
    needs_operand: &mut bool,
    kind: OperatorKind,
) -> Result<(), UnsupportedShellSyntaxKind> {
    if current.trim().is_empty() {
        if kind == OperatorKind::Newline {
            return Ok(());
        }
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    push_segment(current, segments)?;
    *needs_operand = kind == OperatorKind::Binary;
    Ok(())
}

fn push_segment(
    current: &mut String,
    segments: &mut Vec<String>,
) -> Result<(), UnsupportedShellSyntaxKind> {
    let segment = current.trim().to_owned();
    current.clear();
    reject_compound_keyword(&segment)?;
    validate_redirections(&segment)?;
    if segments.len() >= MAX_COMMAND_SEGMENTS {
        return Err(UnsupportedShellSyntaxKind::SegmentLimit);
    }
    segments.push(segment);
    Ok(())
}

fn reject_compound_keyword(segment: &str) -> Result<(), UnsupportedShellSyntaxKind> {
    let first = segment
        .split_ascii_whitespace()
        .find(|word| !looks_like_assignment(word))
        .unwrap_or_default();
    if first == "function" {
        return Err(UnsupportedShellSyntaxKind::FunctionDefinition);
    }
    if matches!(
        first,
        "if" | "then"
            | "elif"
            | "else"
            | "fi"
            | "for"
            | "while"
            | "until"
            | "do"
            | "done"
            | "case"
            | "esac"
            | "select"
            | "time"
            | "coproc"
            | "!"
            | "[["
    ) {
        return Err(UnsupportedShellSyntaxKind::CompoundCommand);
    }
    Ok(())
}

fn looks_like_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(position, value)| {
            value == '_'
                || value.is_ascii_alphanumeric() && (position > 0 || !value.is_ascii_digit())
        })
}

fn validate_redirections(segment: &str) -> Result<(), UnsupportedShellSyntaxKind> {
    let bytes = segment.as_bytes();
    let mut index = 0usize;
    let mut quote = QuoteState::None;
    while index < bytes.len() {
        match quote {
            QuoteState::Single => {
                if bytes[index] == b'\'' {
                    quote = QuoteState::None;
                }
                index += 1;
                continue;
            }
            QuoteState::Double | QuoteState::AnsiC => {
                if bytes[index] == b'\\' {
                    index += 1;
                    if index >= bytes.len() {
                        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
                    }
                    index += segment[index..]
                        .chars()
                        .next()
                        .expect("索引应位于字符边界")
                        .len_utf8();
                    continue;
                } else if bytes[index]
                    == if quote == QuoteState::Double {
                        b'"'
                    } else {
                        b'\''
                    }
                {
                    quote = QuoteState::None;
                }
                index += 1;
                continue;
            }
            QuoteState::None => {}
        }

        match bytes[index] {
            b'\\' => {
                index += 1;
                if index >= bytes.len() {
                    return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
                }
                index += segment[index..]
                    .chars()
                    .next()
                    .expect("索引应位于字符边界")
                    .len_utf8();
            }
            b'$' if bytes[index..].starts_with(b"$'") => {
                quote = QuoteState::AnsiC;
                index += 2;
            }
            b'\'' => {
                quote = QuoteState::Single;
                index += 1;
            }
            b'"' => {
                quote = QuoteState::Double;
                index += 1;
            }
            b'$' if bytes[index..].starts_with(b"${") => {
                index = consume_parameter_expansion(segment, index)?;
            }
            b'&' if bytes.get(index + 1) == Some(&b'>') => {
                let operator_end = if bytes.get(index + 2) == Some(&b'>') {
                    index + 3
                } else {
                    index + 2
                };
                index = redirection_target_start(bytes, operator_end)?;
            }
            b'<' | b'>' => {
                let operator_start = index;
                index += 1;
                if bytes.get(index) == Some(&bytes[operator_start])
                    || matches!(bytes.get(index), Some(b'&' | b'|' | b'>'))
                {
                    index += 1;
                }
                index = redirection_target_start(bytes, index)?;
            }
            _ => {
                index += segment[index..]
                    .chars()
                    .next()
                    .expect("索引应位于字符边界")
                    .len_utf8();
            }
        }
    }
    Ok(())
}

fn redirection_target_start(
    bytes: &[u8],
    mut index: usize,
) -> Result<usize, UnsupportedShellSyntaxKind> {
    while matches!(bytes.get(index), Some(b' ' | b'\t' | b'\r')) {
        index += 1;
    }
    if index >= bytes.len() || matches!(bytes[index], b'<' | b'>' | b'&' | b'|' | b';') {
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    Ok(index)
}

fn reject_expansion(bytes: &[u8], index: usize) -> Result<(), UnsupportedShellSyntaxKind> {
    if bytes[index..].starts_with(b"$((") {
        return Err(UnsupportedShellSyntaxKind::ArithmeticExpansion);
    }
    if bytes[index..].starts_with(b"$(") {
        return Err(UnsupportedShellSyntaxKind::CommandSubstitution);
    }
    Ok(())
}

fn consume_parameter_expansion(
    command: &str,
    start: usize,
) -> Result<usize, UnsupportedShellSyntaxKind> {
    let bytes = command.as_bytes();
    let mut index = start + 2;
    let mut depth = 1usize;
    let mut quote = QuoteState::None;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index += 1;
            if index >= bytes.len() {
                return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
            }
            index += command[index..]
                .chars()
                .next()
                .expect("索引应位于字符边界")
                .len_utf8();
            continue;
        }
        if quote == QuoteState::Single {
            if bytes[index] == b'\'' {
                quote = QuoteState::None;
            }
            index += 1;
            continue;
        }
        if bytes[index] == b'\'' {
            quote = QuoteState::Single;
            index += 1;
            continue;
        }
        reject_expansion(bytes, index)?;
        if bytes[index] == b'`' {
            return Err(UnsupportedShellSyntaxKind::CommandSubstitution);
        }
        if matches!(bytes[index], b'<' | b'>') && bytes.get(index + 1) == Some(&b'(') {
            return Err(UnsupportedShellSyntaxKind::ProcessSubstitution);
        }
        if bytes[index..].starts_with(b"${") {
            depth += 1;
            index += 2;
        } else if bytes[index] == b'}' {
            depth -= 1;
            index += 1;
            if depth == 0 {
                return Ok(index);
            }
        } else {
            index += command[index..]
                .chars()
                .next()
                .expect("索引应位于字符边界")
                .len_utf8();
        }
    }
    Err(UnsupportedShellSyntaxKind::MalformedSyntax)
}

fn looks_like_function_definition(current: &str, bytes: &[u8], index: usize) -> bool {
    if bytes.get(index + 1) != Some(&b')') {
        return false;
    }
    let name = current
        .split_ascii_whitespace()
        .next_back()
        .unwrap_or_default();
    !name.is_empty()
        && name.chars().enumerate().all(|(position, value)| {
            value == '_'
                || value.is_ascii_alphanumeric() && (position > 0 || !value.is_ascii_digit())
        })
}

fn is_redirection_ampersand(bytes: &[u8], index: usize, current: &str) -> bool {
    bytes.get(index + 1) == Some(&b'>')
        || bytes.get(index + 1) != Some(&b'&')
            && matches!(current.as_bytes().last(), Some(b'>' | b'<'))
}

fn push_char(command: &str, index: &mut usize, output: &mut String) {
    let value = command[*index..]
        .chars()
        .next()
        .expect("索引应位于字符边界");
    output.push(value);
    *index += value.len_utf8();
}

fn push_escaped(
    command: &str,
    index: &mut usize,
    output: &mut String,
) -> Result<(), UnsupportedShellSyntaxKind> {
    output.push('\\');
    *index += 1;
    if *index >= command.len() {
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    let escaped = command[*index..]
        .chars()
        .next()
        .expect("索引应位于字符边界");
    if escaped.is_control() && !matches!(escaped, '\n' | '\t' | '\r') {
        return Err(UnsupportedShellSyntaxKind::MalformedSyntax);
    }
    output.push(escaped);
    *index += escaped.len_utf8();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 拆分所有支持的控制运算符() {
        let segments = split_simple_command_chain(
            "echo 一; pwd && ls || true | cat |& tee log & whoami\nprintf done",
        )
        .expect("应成功拆分");
        assert_eq!(
            segments,
            [
                "echo 一",
                "pwd",
                "ls",
                "true",
                "cat",
                "tee log",
                "whoami",
                "printf done"
            ]
        );
    }

    #[test]
    fn 引号转义注释和重定向不会错误拆分() {
        let segments = split_simple_command_chain(
            "printf '%s;|' \"a&&b\" $'c\\nd' foo\\;bar \\你 2>&1 &>>out >|forced # 注释 ; rm\necho ${HOME}",
        )
        .expect("应成功拆分");
        assert_eq!(
            segments,
            [
                "printf '%s;|' \"a&&b\" $'c\\nd' foo\\;bar \\你 2>&1 &>>out >|forced",
                "echo ${HOME}"
            ]
        );
    }

    #[test]
    fn 返回稳定的拒绝语法类别() {
        let cases = [
            (
                "echo $(pwd)",
                UnsupportedShellSyntaxKind::CommandSubstitution,
            ),
            (
                "cat <(printf x)",
                UnsupportedShellSyntaxKind::ProcessSubstitution,
            ),
            (
                "echo $((1+1))",
                UnsupportedShellSyntaxKind::ArithmeticExpansion,
            ),
            ("(pwd)", UnsupportedShellSyntaxKind::Subshell),
            ("{ pwd; }", UnsupportedShellSyntaxKind::CommandGroup),
            (
                "f() { pwd; }",
                UnsupportedShellSyntaxKind::FunctionDefinition,
            ),
            (
                "if true; then pwd; fi",
                UnsupportedShellSyntaxKind::CompoundCommand,
            ),
            ("cat <<EOF", UnsupportedShellSyntaxKind::HereDocument),
            ("pwd &&", UnsupportedShellSyntaxKind::MalformedSyntax),
            ("echo >", UnsupportedShellSyntaxKind::MalformedSyntax),
            ("echo \0", UnsupportedShellSyntaxKind::MalformedSyntax),
        ];
        for (command, expected) in cases {
            assert_eq!(
                split_simple_command_chain(command),
                Err(expected),
                "{command}"
            );
        }
    }

    #[test]
    fn 超过段数限制时拒绝() {
        let command = std::iter::repeat_n("pwd", MAX_COMMAND_SEGMENTS + 1)
            .collect::<Vec<_>>()
            .join(";");
        assert_eq!(
            split_simple_command_chain(&command),
            Err(UnsupportedShellSyntaxKind::SegmentLimit)
        );
    }
}
