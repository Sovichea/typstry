#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanState {
    MarkupText,
    CodeExpression,
    Math,
    RawInline,
    RawBlock,
    LineComment,
    BlockComment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeState {
    pub par_justify: bool,
    pub render_prep_disabled: bool,
}

impl Default for ScopeState {
    fn default() -> Self {
        Self {
            par_justify: false,
            render_prep_disabled: false,
        }
    }
}

fn parse_set_rule_args(args_str: &str, scope: &mut ScopeState, is_text: bool) {
    let clean: String = args_str.chars().filter(|c| !c.is_whitespace()).collect();
    if !is_text {
        if clean.contains("justify:true") {
            scope.par_justify = true;
        } else if clean.contains("justify:false") {
            scope.par_justify = false;
        }
    }
}

fn parse_line_comment_directive(comment: &str, scope: &mut ScopeState) {
    if comment.contains("@disable-render-prep") {
        scope.render_prep_disabled = true;
    }
}

fn match_set_rule(chars: &[(usize, char)], start_idx: usize) -> Option<(bool, String)> {
    if start_idx + 3 >= chars.len() {
        return None;
    }
    if chars[start_idx].1 != 's' || chars[start_idx + 1].1 != 'e' || chars[start_idx + 2].1 != 't' {
        return None;
    }

    let mut idx = start_idx + 3;
    if idx >= chars.len() || !chars[idx].1.is_whitespace() {
        return None;
    }
    while idx < chars.len() && chars[idx].1.is_whitespace() {
        idx += 1;
    }

    let is_text;
    if idx + 4 < chars.len()
        && chars[idx].1 == 't'
        && chars[idx + 1].1 == 'e'
        && chars[idx + 2].1 == 'x'
        && chars[idx + 3].1 == 't'
    {
        is_text = true;
        idx += 4;
    } else if idx + 3 < chars.len()
        && chars[idx].1 == 'p'
        && chars[idx + 1].1 == 'a'
        && chars[idx + 2].1 == 'r'
    {
        is_text = false;
        idx += 3;
    } else {
        return None;
    }

    while idx < chars.len() && chars[idx].1.is_whitespace() {
        idx += 1;
    }
    if idx >= chars.len() || chars[idx].1 != '(' {
        return None;
    }
    idx += 1;

    let mut bracket_count = 1;
    let mut args_str = String::new();
    while idx < chars.len() {
        let c = chars[idx].1;
        if c == '(' {
            bracket_count += 1;
        } else if c == ')' {
            bracket_count -= 1;
            if bracket_count == 0 {
                break;
            }
        }
        args_str.push(c);
        idx += 1;
    }

    Some((is_text, args_str))
}

pub fn scan_typst_content(content: &str) -> Vec<(ScanState, usize, usize, ScopeState)> {
    let chars: Vec<(usize, char)> = content.char_indices().collect();
    let mut chunks = Vec::new();
    let mut i = 0;
    let mut current_state = ScanState::MarkupText;
    let mut chunk_start = 0;

    let mut bracket_stack = Vec::new();
    let mut scopes = vec![ScopeState::default()];
    let mut in_string = false;

    while i < chars.len() {
        let (pos, c) = chars[i];

        let check_idx = if c == '#' { i + 1 } else { i };
        if let Some((is_text, args_str)) = match_set_rule(&chars, check_idx) {
            if pos > chunk_start {
                chunks.push((
                    current_state,
                    chunk_start,
                    pos,
                    scopes.last().cloned().unwrap_or_default(),
                ));
            }
            chunk_start = pos;
            if let Some(current_scope) = scopes.last_mut() {
                parse_set_rule_args(&args_str, current_scope, is_text);
            }
        }

        match current_state {
            ScanState::MarkupText => {
                if c == '[' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    scopes.push(scopes.last().cloned().unwrap_or_default());
                    chunk_start = pos;
                } else if c == ']' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    if scopes.len() > 1 {
                        scopes.pop();
                    }
                    chunk_start = pos;

                    if bracket_stack.last() == Some(&']') {
                        bracket_stack.pop();
                        current_state = ScanState::CodeExpression;
                        i += 1;
                        continue;
                    }
                }

                if c == '/' && i + 1 < chars.len() && chars[i + 1].1 == '*' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    current_state = ScanState::BlockComment;
                    chunk_start = pos;
                    i += 2;
                    continue;
                }
                if c == '/' && i + 1 < chars.len() && chars[i + 1].1 == '/' {
                    let preceded_by_colon = if i > 0 { chars[i - 1].1 == ':' } else { false };
                    if !preceded_by_colon {
                        if pos > chunk_start {
                            chunks.push((
                                ScanState::MarkupText,
                                chunk_start,
                                pos,
                                scopes.last().cloned().unwrap_or_default(),
                            ));
                        }
                        current_state = ScanState::LineComment;
                        chunk_start = pos;
                        i += 2;
                        continue;
                    }
                }
                if c == '`' && i + 2 < chars.len() && chars[i + 1].1 == '`' && chars[i + 2].1 == '`'
                {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    current_state = ScanState::RawBlock;
                    chunk_start = pos;
                    i += 3;
                    continue;
                }
                if c == '`' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    current_state = ScanState::RawInline;
                    chunk_start = pos;
                    i += 1;
                    continue;
                }
                if c == '$' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::MarkupText,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    current_state = ScanState::Math;
                    chunk_start = pos;
                    i += 1;
                    continue;
                }
                if c == '#' {
                    let is_valid_start = if i + 1 < chars.len() {
                        let next_c = chars[i + 1].1;
                        !next_c.is_whitespace() && next_c != '/' && next_c != '*' && next_c != '#'
                    } else {
                        false
                    };
                    if is_valid_start {
                        if pos > chunk_start {
                            chunks.push((
                                ScanState::MarkupText,
                                chunk_start,
                                pos,
                                scopes.last().cloned().unwrap_or_default(),
                            ));
                        }
                        current_state = ScanState::CodeExpression;
                        chunk_start = pos;
                        bracket_stack.clear();
                        in_string = false;
                        i += 1;
                        continue;
                    }
                }
                i += 1;
            }
            ScanState::LineComment => {
                if c == '\n' {
                    let end_pos = pos + c.len_utf8();
                    if let Some(current_scope) = scopes.last_mut() {
                        parse_line_comment_directive(&content[chunk_start..end_pos], current_scope);
                    }
                    chunks.push((
                        ScanState::LineComment,
                        chunk_start,
                        end_pos,
                        scopes.last().cloned().unwrap_or_default(),
                    ));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                }
                i += 1;
            }
            ScanState::BlockComment => {
                if c == '*' && i + 1 < chars.len() && chars[i + 1].1 == '/' {
                    let end_pos = chars[i + 1].0 + 1;
                    chunks.push((
                        ScanState::BlockComment,
                        chunk_start,
                        end_pos,
                        scopes.last().cloned().unwrap_or_default(),
                    ));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            ScanState::RawBlock => {
                if c == '`' && i + 2 < chars.len() && chars[i + 1].1 == '`' && chars[i + 2].1 == '`'
                {
                    let end_pos = chars[i + 2].0 + 1;
                    chunks.push((
                        ScanState::RawBlock,
                        chunk_start,
                        end_pos,
                        scopes.last().cloned().unwrap_or_default(),
                    ));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 3;
                    continue;
                }
                i += 1;
            }
            ScanState::RawInline => {
                if c == '`' {
                    let end_pos = pos + 1;
                    chunks.push((
                        ScanState::RawInline,
                        chunk_start,
                        end_pos,
                        scopes.last().cloned().unwrap_or_default(),
                    ));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            ScanState::Math => {
                if c == '$' {
                    let end_pos = pos + 1;
                    chunks.push((
                        ScanState::Math,
                        chunk_start,
                        end_pos,
                        scopes.last().cloned().unwrap_or_default(),
                    ));
                    current_state = ScanState::MarkupText;
                    chunk_start = end_pos;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            ScanState::CodeExpression => {
                if in_string {
                    if c == '"' {
                        let is_escaped = if i > 0 {
                            let mut backslash_count = 0;
                            let mut prev_idx = i - 1;
                            while chars[prev_idx].1 == '\\' {
                                backslash_count += 1;
                                if prev_idx == 0 {
                                    break;
                                }
                                prev_idx -= 1;
                            }
                            backslash_count % 2 == 1
                        } else {
                            false
                        };
                        if !is_escaped {
                            in_string = false;
                        }
                    }
                    i += 1;
                    continue;
                }

                if c == '"' {
                    in_string = true;
                    i += 1;
                    continue;
                }

                if c == '(' {
                    bracket_stack.push(')');
                    scopes.push(scopes.last().cloned().unwrap_or_default());
                } else if c == '{' {
                    bracket_stack.push('}');
                    scopes.push(scopes.last().cloned().unwrap_or_default());
                } else if c == '[' {
                    if pos > chunk_start {
                        chunks.push((
                            ScanState::CodeExpression,
                            chunk_start,
                            pos,
                            scopes.last().cloned().unwrap_or_default(),
                        ));
                    }
                    bracket_stack.push(']');
                    scopes.push(scopes.last().cloned().unwrap_or_default());
                    current_state = ScanState::MarkupText;
                    chunk_start = pos;
                    i += 1;
                    continue;
                } else if c == ')' || c == '}' {
                    if bracket_stack.last() == Some(&c) {
                        bracket_stack.pop();
                        if scopes.len() > 1 {
                            scopes.pop();
                        }
                    }
                }

                if bracket_stack.is_empty() {
                    let is_keyword_statement = if chunk_start < pos {
                        let text_so_far = &content[chunk_start..pos];
                        text_so_far.starts_with("#let")
                            || text_so_far.starts_with("#set")
                            || text_so_far.starts_with("#show")
                            || text_so_far.starts_with("#import")
                            || text_so_far.starts_with("#include")
                    } else {
                        false
                    };

                    let should_end = if is_keyword_statement {
                        c == '\n' || c == ';'
                    } else {
                        c.is_whitespace()
                            || c == ';'
                            || c == ','
                            || c == '.'
                            || c == '/'
                            || c == '*'
                            || c == '+'
                            || c == '-'
                            || c == '='
                            || c == '<'
                            || c == '>'
                            || c == '!'
                    };

                    if should_end {
                        let continues = if c == '.' && i + 1 < chars.len() {
                            chars[i + 1].1.is_alphanumeric()
                        } else {
                            false
                        };

                        if !continues {
                            chunks.push((
                                ScanState::CodeExpression,
                                chunk_start,
                                pos,
                                scopes.last().cloned().unwrap_or_default(),
                            ));
                            current_state = ScanState::MarkupText;
                            chunk_start = pos;
                        }
                    }
                }
                i += 1;
            }
        }
    }

    let end_pos = content.len();
    if end_pos > chunk_start {
        if current_state == ScanState::LineComment {
            if let Some(current_scope) = scopes.last_mut() {
                parse_line_comment_directive(&content[chunk_start..end_pos], current_scope);
            }
        }
        chunks.push((
            current_state,
            chunk_start,
            end_pos,
            scopes.last().cloned().unwrap_or_default(),
        ));
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_plain_markup() {
        let content = "Hello World! នេះជាភាសាខ្មែរ";
        let chunks = scan_typst_content(content);
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0],
            (
                ScanState::MarkupText,
                0,
                content.len(),
                ScopeState::default()
            )
        );
    }

    #[test]
    fn test_scan_comments() {
        let content = "Hello // line comment\nWorld /* block comment */!";
        let chunks = scan_typst_content(content);
        assert_eq!(chunks.len(), 5);

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(chunks[1].0, ScanState::LineComment);
        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(chunks[3].0, ScanState::BlockComment);
        assert_eq!(chunks[4].0, ScanState::MarkupText);

        assert_eq!(&content[chunks[1].1..chunks[1].2], "// line comment\n");
        assert_eq!(&content[chunks[3].1..chunks[3].2], "/* block comment */");
    }

    #[test]
    fn test_scan_raw_and_math() {
        let content = "Hello `raw inline` and $x + y = z$ and ```\nraw block\n```";
        let chunks = scan_typst_content(content);

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(chunks[1].0, ScanState::RawInline);
        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(chunks[3].0, ScanState::Math);
        assert_eq!(chunks[4].0, ScanState::MarkupText);
        assert_eq!(chunks[5].0, ScanState::RawBlock);

        assert_eq!(&content[chunks[1].1..chunks[1].2], "`raw inline`");
        assert_eq!(&content[chunks[3].1..chunks[3].2], "$x + y = z$");
        assert_eq!(&content[chunks[5].1..chunks[5].2], "```\nraw block\n```");
    }

    #[test]
    fn test_scan_code_expressions() {
        let content = "Heading #rect(width: 10pt)[Inside content] trailing text.";
        let chunks = scan_typst_content(content);

        // Expected:
        // 0: MarkupText "Heading "
        // 1: CodeExpression "#rect(width: 10pt)"
        // 2: MarkupText "[Inside content]"
        // 3: CodeExpression "]" // Wait, closing bracket is part of the code block structure
        // 4: MarkupText " trailing text."

        assert_eq!(chunks[0].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[0].1..chunks[0].2], "Heading ");

        assert_eq!(chunks[1].0, ScanState::CodeExpression);
        assert_eq!(&content[chunks[1].1..chunks[1].2], "#rect(width: 10pt)");

        assert_eq!(chunks[2].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[2].1..chunks[2].2], "[Inside content");

        assert_eq!(chunks[3].0, ScanState::CodeExpression);
        assert_eq!(&content[chunks[3].1..chunks[3].2], "]");

        assert_eq!(chunks[4].0, ScanState::MarkupText);
        assert_eq!(&content[chunks[4].1..chunks[4].2], " trailing text.");
    }

    #[test]
    fn test_scan_scope_aware_set_rules() {
        let content = r#"
        #set par(justify: true)
        Text 1
        [
            Text 2
        ]
        Text 3
        "#;
        let chunks = scan_typst_content(content);

        let mut text_1_found = false;
        let mut text_2_found = false;
        let mut text_3_found = false;

        for chunk in &chunks {
            let chunk_text = &content[chunk.1..chunk.2];
            if chunk_text.contains("Text 1") {
                assert!(chunk.3.par_justify);
                assert!(!chunk.3.render_prep_disabled);
                text_1_found = true;
            } else if chunk_text.contains("Text 2") {
                assert!(chunk.3.par_justify);
                assert!(!chunk.3.render_prep_disabled);
                text_2_found = true;
            } else if chunk_text.contains("Text 3") {
                assert!(chunk.3.par_justify);
                assert!(!chunk.3.render_prep_disabled);
                text_3_found = true;
            }
        }

        assert!(text_1_found);
        assert!(text_2_found);
        assert!(text_3_found);
    }

    #[test]
    fn test_scan_ignores_text_rules_for_khmer_render_preparation() {
        let content = r#"
        #set text(lang: "en")
        #set par(justify: true)
        Text
        "#;
        let chunks = scan_typst_content(content);

        let text_chunk = chunks
            .iter()
            .find(|chunk| content[chunk.1..chunk.2].contains("Text"))
            .expect("expected text chunk");

        assert!(text_chunk.3.par_justify);
        assert!(!text_chunk.3.render_prep_disabled);
    }

    #[test]
    fn test_disable_render_prep_directive_is_scope_aware() {
        let content = r#"
        #set par(justify: true)
        [
            // @disable-render-prep
            Disabled text
        ]
        Enabled text
        "#;
        let chunks = scan_typst_content(content);

        let disabled_chunk = chunks
            .iter()
            .find(|chunk| content[chunk.1..chunk.2].contains("Disabled text"))
            .expect("expected disabled text chunk");
        let enabled_chunk = chunks
            .iter()
            .find(|chunk| content[chunk.1..chunk.2].contains("Enabled text"))
            .expect("expected enabled text chunk");

        assert!(disabled_chunk.3.par_justify);
        assert!(disabled_chunk.3.render_prep_disabled);
        assert!(enabled_chunk.3.par_justify);
        assert!(!enabled_chunk.3.render_prep_disabled);
    }
}
