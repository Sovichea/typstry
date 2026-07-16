//! Revision-safe Typst language-scope extraction.
//!
//! This module deliberately stops at syntax. It never evaluates Typst code and
//! never guesses a static language from a dynamic expression.

use serde::{Deserialize, Serialize};
use std::ops::Range;
use std::time::Instant;
use typst_syntax::ast::{self, Arg, AstNode, Expr};
use typst_syntax::{LinkedNode, SyntaxKind};

const PARSER_VERSION: &str = "typst-syntax 0.15.0";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractLanguageScopesRequest {
    pub document_key: String,
    pub revision: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractLanguageScopesResponse {
    pub document_key: String,
    pub revision: u64,
    pub parser_version: &'static str,
    pub document_utf16: usize,
    pub mutations: Vec<TextStyleMutation>,
    pub prose_ranges: Vec<SourceRange>,
    pub syntax_errors: Vec<SourceRange>,
    pub elapsed_micros: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub from_utf16: usize,
    pub to_utf16: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleMutation {
    pub kind: MutationKind,
    pub apply_from_utf16: usize,
    pub apply_to_utf16: usize,
    pub declaration_from_utf16: usize,
    pub declaration_to_utf16: usize,
    pub diagnostic_from_utf16: usize,
    pub diagnostic_to_utf16: usize,
    pub order: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<ExtractedStyleValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<ExtractedStyleValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script: Option<ExtractedStyleValue>,
    pub content_mode: ContentMode,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MutationKind {
    SetRule,
    TextCall,
    ShowRule,
    SyntaxError,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContentMode {
    TypstSource,
    PlainText,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedStyleValue {
    pub confidence: ValueConfidence,
    /// `None` is meaningful for a statically written `region: none`.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValueConfidence {
    Static,
    Dynamic,
}

#[tauri::command]
pub async fn extract_typst_language_scopes(
    request: ExtractLanguageScopesRequest,
) -> Result<ExtractLanguageScopesResponse, String> {
    tauri::async_runtime::spawn_blocking(move || extract(request))
        .await
        .map_err(|error| format!("Language-scope parser task failed: {error}"))
}

fn extract(request: ExtractLanguageScopesRequest) -> ExtractLanguageScopesResponse {
    let started = Instant::now();
    let utf16 = Utf16Map::new(&request.text);
    let root = typst_syntax::parse(&request.text);
    let linked = LinkedNode::new(&root);
    let mut collector = Collector {
        utf16: &utf16,
        mutations: Vec::new(),
        prose_ranges: Vec::new(),
        syntax_errors: Vec::new(),
        order: 0,
    };
    collector.visit(&linked);
    collector.prose_ranges.sort_by_key(|range| range.from_utf16);
    collector.prose_ranges.dedup();

    ExtractLanguageScopesResponse {
        document_key: request.document_key,
        revision: request.revision,
        parser_version: PARSER_VERSION,
        document_utf16: utf16.document_len(),
        mutations: collector.mutations,
        prose_ranges: collector.prose_ranges,
        syntax_errors: collector.syntax_errors,
        elapsed_micros: started.elapsed().as_micros().min(u64::MAX as u128) as u64,
    }
}

struct Collector<'a> {
    utf16: &'a Utf16Map<'a>,
    mutations: Vec<TextStyleMutation>,
    prose_ranges: Vec<SourceRange>,
    syntax_errors: Vec<SourceRange>,
    order: usize,
}

impl Collector<'_> {
    fn visit(&mut self, node: &LinkedNode<'_>) {
        match node.kind() {
            SyntaxKind::Text if is_spellcheck_prose(node) => {
                self.prose_ranges.push(self.range(node.range()));
            }
            SyntaxKind::Error => self.record_error(node),
            SyntaxKind::SetRule => self.record_set_rule(node),
            SyntaxKind::ShowRule => self.record_show_rule(node),
            SyntaxKind::FuncCall => self.record_text_call(node),
            _ => {}
        }
        for child in node.children() {
            self.visit(&child);
        }
    }

    fn record_set_rule(&mut self, node: &LinkedNode<'_>) {
        if has_ancestor(node, SyntaxKind::ShowRule) {
            return;
        }
        let Some(rule) = node.get().cast::<ast::SetRule>() else {
            return;
        };
        if !is_text_expr(rule.target()) {
            return;
        }
        let (mut language, mut region, mut script) = style_args(rule.args());
        if language.is_none() && region.is_none() && script.is_none() {
            return;
        }
        match rule.condition() {
            Some(Expr::Bool(value)) if !value.get() => return,
            Some(Expr::Bool(_)) | None => {}
            Some(_) => make_dynamic(&mut language, &mut region, &mut script),
        }
        let scope_end = lexical_scope_end(node);
        self.push_mutation(
            MutationKind::SetRule,
            node.range().end..scope_end,
            node.range(),
            node.range(),
            language,
            region,
            script,
            ContentMode::TypstSource,
        );
    }

    fn record_show_rule(&mut self, node: &LinkedNode<'_>) {
        let Some(rule) = node.get().cast::<ast::ShowRule>() else {
            return;
        };
        let Expr::SetRule(set) = rule.transform() else {
            return;
        };
        if !is_text_expr(set.target()) {
            return;
        }
        let (mut language, mut region, mut script) = style_args(set.args());
        if language.is_none() && region.is_none() && script.is_none() {
            return;
        }
        make_dynamic(&mut language, &mut region, &mut script);
        self.push_mutation(
            MutationKind::ShowRule,
            node.range().end..lexical_scope_end(node),
            node.range(),
            node.range(),
            language,
            region,
            script,
            ContentMode::TypstSource,
        );
    }

    fn record_text_call(&mut self, node: &LinkedNode<'_>) {
        let Some(call) = node.get().cast::<ast::FuncCall>() else {
            return;
        };
        if !is_text_expr(call.callee()) {
            return;
        }
        let (mut language, mut region, mut script) = style_args(call.args());
        if language.is_none() && region.is_none() && script.is_none() {
            return;
        }
        // A preceding lexical binding named `text` makes the callee ambiguous.
        if text_is_shadowed(node) {
            make_dynamic(&mut language, &mut region, &mut script);
        }
        for arg in call.args().items() {
            let Arg::Pos(body) = arg else { continue };
            match body {
                Expr::ContentBlock(content) => {
                    if let Some(linked_body) = find_node(node, content.body().to_untyped()) {
                        self.push_mutation(
                            MutationKind::TextCall,
                            linked_body.range(),
                            node.range(),
                            node.range(),
                            language.clone(),
                            region.clone(),
                            script.clone(),
                            ContentMode::TypstSource,
                        );
                    }
                }
                Expr::Str(string) => {
                    if let Some(linked_string) = find_node(node, string.to_untyped()) {
                        let range = linked_string.range();
                        if range.end > range.start + 1 {
                            let body = range.start + 1..range.end - 1;
                            self.push_mutation(
                                MutationKind::TextCall,
                                body.clone(),
                                node.range(),
                                node.range(),
                                language.clone(),
                                region.clone(),
                                script.clone(),
                                ContentMode::PlainText,
                            );
                            self.record_plain_string_ranges(body);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn record_plain_string_ranges(&mut self, bytes: Range<usize>) {
        // Escaped source has no one-to-one rendered/source mapping. Split at
        // escapes and expose only source spans whose mapping is exact.
        let source = self.utf16.source.as_bytes();
        let mut start = bytes.start;
        let mut cursor = bytes.start;
        while cursor < bytes.end {
            if source[cursor] == b'\\' {
                if start < cursor {
                    self.prose_ranges.push(self.range(start..cursor));
                }
                cursor += 1;
                if cursor < bytes.end && source[cursor] == b'u' {
                    while cursor < bytes.end && source[cursor] != b'}' {
                        cursor += 1;
                    }
                }
                cursor = (cursor + 1).min(bytes.end);
                start = cursor;
            } else {
                cursor += 1;
            }
        }
        if start < bytes.end {
            self.prose_ranges.push(self.range(start..bytes.end));
        }
    }

    fn record_error(&mut self, node: &LinkedNode<'_>) {
        let error = self.range(node.range());
        self.syntax_errors.push(error.clone());
        self.push_mutation(
            MutationKind::SyntaxError,
            node.range().start..lexical_scope_end(node),
            node.range(),
            node.range(),
            Some(dynamic()),
            Some(dynamic()),
            Some(dynamic()),
            ContentMode::TypstSource,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn push_mutation(
        &mut self,
        kind: MutationKind,
        apply: Range<usize>,
        declaration: Range<usize>,
        diagnostic: Range<usize>,
        language: Option<ExtractedStyleValue>,
        region: Option<ExtractedStyleValue>,
        script: Option<ExtractedStyleValue>,
        content_mode: ContentMode,
    ) {
        if apply.start >= apply.end {
            return;
        }
        self.order += 1;
        let apply = self.range(apply);
        let declaration = self.range(declaration);
        let diagnostic = self.range(diagnostic);
        self.mutations.push(TextStyleMutation {
            kind,
            apply_from_utf16: apply.from_utf16,
            apply_to_utf16: apply.to_utf16,
            declaration_from_utf16: declaration.from_utf16,
            declaration_to_utf16: declaration.to_utf16,
            diagnostic_from_utf16: diagnostic.from_utf16,
            diagnostic_to_utf16: diagnostic.to_utf16,
            order: self.order,
            language,
            region,
            script,
            content_mode,
        });
    }

    fn range(&self, range: Range<usize>) -> SourceRange {
        SourceRange {
            from_utf16: self.utf16.at(range.start),
            to_utf16: self.utf16.at(range.end),
        }
    }
}

fn style_args(
    args: ast::Args<'_>,
) -> (
    Option<ExtractedStyleValue>,
    Option<ExtractedStyleValue>,
    Option<ExtractedStyleValue>,
) {
    let mut language = None;
    let mut region = None;
    let mut script = None;
    for arg in args.items() {
        match arg {
            Arg::Named(named) => {
                let slot = match named.name().as_str() {
                    "lang" => &mut language,
                    "region" => &mut region,
                    "script" => &mut script,
                    _ => continue,
                };
                *slot = Some(expr_value(named.expr()));
            }
            Arg::Spread(_) => {
                language = Some(dynamic());
                region = Some(dynamic());
                script = Some(dynamic());
            }
            Arg::Pos(_) => {}
        }
    }
    (language, region, script)
}

fn expr_value(expr: Expr<'_>) -> ExtractedStyleValue {
    match expr {
        Expr::Str(value) => ExtractedStyleValue {
            confidence: ValueConfidence::Static,
            value: Some(value.get().to_string()),
        },
        Expr::None(_) => ExtractedStyleValue {
            confidence: ValueConfidence::Static,
            value: None,
        },
        Expr::Auto(_) => ExtractedStyleValue {
            confidence: ValueConfidence::Static,
            value: Some("auto".into()),
        },
        _ => dynamic(),
    }
}

fn dynamic() -> ExtractedStyleValue {
    ExtractedStyleValue {
        confidence: ValueConfidence::Dynamic,
        value: None,
    }
}

fn make_dynamic(
    language: &mut Option<ExtractedStyleValue>,
    region: &mut Option<ExtractedStyleValue>,
    script: &mut Option<ExtractedStyleValue>,
) {
    for value in [language, region, script] {
        if value.is_some() {
            *value = Some(dynamic());
        }
    }
}

fn is_text_expr(expr: Expr<'_>) -> bool {
    matches!(expr, Expr::Ident(ident) if ident.as_str() == "text")
}

fn lexical_scope_end(node: &LinkedNode<'_>) -> usize {
    let mut parent = node.parent();
    while let Some(candidate) = parent {
        if matches!(candidate.kind(), SyntaxKind::Markup | SyntaxKind::Code)
            && candidate.range().end > node.range().end
        {
            return candidate.range().end;
        }
        parent = candidate.parent();
    }
    node.range().end
}

fn has_ancestor(node: &LinkedNode<'_>, kind: SyntaxKind) -> bool {
    let mut parent = node.parent();
    while let Some(candidate) = parent {
        if candidate.kind() == kind {
            return true;
        }
        parent = candidate.parent();
    }
    false
}

fn is_spellcheck_prose(node: &LinkedNode<'_>) -> bool {
    let mut parent = node.parent();
    while let Some(candidate) = parent {
        if matches!(
            candidate.kind(),
            SyntaxKind::Raw
                | SyntaxKind::Math
                | SyntaxKind::Equation
                | SyntaxKind::Label
                | SyntaxKind::Ref
                | SyntaxKind::Link
                | SyntaxKind::LineComment
                | SyntaxKind::BlockComment
                | SyntaxKind::Str
        ) {
            return false;
        }
        parent = candidate.parent();
    }
    true
}

fn find_node<'a>(
    root: &LinkedNode<'a>,
    target: &'a typst_syntax::SyntaxNode,
) -> Option<LinkedNode<'a>> {
    if std::ptr::eq(root.get(), target) {
        return Some(root.clone());
    }
    root.children().find_map(|child| find_node(&child, target))
}

fn text_is_shadowed(node: &LinkedNode<'_>) -> bool {
    let call_start = node.range().start;
    let mut scope = node.parent();
    while let Some(parent) = scope {
        for child in parent.children() {
            if child.range().start >= call_start {
                break;
            }
            if child.kind() == SyntaxKind::LetBinding
                && child
                    .get()
                    .cast::<ast::LetBinding>()
                    .is_some_and(|binding| {
                        binding
                            .kind()
                            .bindings()
                            .iter()
                            .any(|ident| ident.as_str() == "text")
                    })
            {
                return true;
            }
        }
        if matches!(parent.kind(), SyntaxKind::Markup | SyntaxKind::Code) {
            break;
        }
        scope = parent.parent();
    }
    false
}

struct Utf16Map<'a> {
    source: &'a str,
    offsets: Vec<usize>,
}

impl<'a> Utf16Map<'a> {
    fn new(source: &'a str) -> Self {
        let mut offsets = vec![0; source.len() + 1];
        let mut utf16 = 0;
        for (byte, character) in source.char_indices() {
            offsets[byte] = utf16;
            let next = byte + character.len_utf8();
            utf16 += character.len_utf16();
            for offset in offsets.iter_mut().take(next + 1).skip(byte + 1) {
                *offset = utf16;
            }
        }
        Self { source, offsets }
    }

    fn at(&self, byte: usize) -> usize {
        self.offsets[byte.min(self.source.len())]
    }

    fn document_len(&self) -> usize {
        self.at(self.source.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> ExtractLanguageScopesResponse {
        extract(ExtractLanguageScopesRequest {
            document_key: "fixture.typ".into(),
            revision: 7,
            text: text.into(),
        })
    }

    #[test]
    fn extracts_set_and_direct_scopes_with_independent_fields() {
        let output = parse("#set text(lang: \"fr\")\nBonjour #text(region: \"CA\")[monde]");
        assert_eq!(output.revision, 7);
        assert!(output.mutations.iter().any(|item| {
            item.kind == MutationKind::SetRule
                && item
                    .language
                    .as_ref()
                    .and_then(|value| value.value.as_deref())
                    == Some("fr")
        }));
        assert!(output.mutations.iter().any(|item| {
            item.kind == MutationKind::TextCall
                && item
                    .region
                    .as_ref()
                    .and_then(|value| value.value.as_deref())
                    == Some("CA")
                && item.language.is_none()
        }));
    }

    #[test]
    fn preserves_utf16_offsets_after_non_bmp_text() {
        let source = "😀 #text(lang: \"km\")[សួស្តី]";
        let output = parse(source);
        let mutation = output
            .mutations
            .iter()
            .find(|item| item.kind == MutationKind::TextCall)
            .unwrap();
        let expected = source.encode_utf16().collect::<Vec<_>>();
        assert!(mutation.apply_from_utf16 < expected.len());
        assert_eq!(
            &expected[mutation.apply_from_utf16..mutation.apply_to_utf16],
            "សួស្តី".encode_utf16().collect::<Vec<_>>()
        );
    }

    #[test]
    fn set_if_and_show_set_are_never_treated_as_unconditional_static_rules() {
        let output =
            parse("#set text(lang: \"fr\") if flag\n#show heading: set text(lang: \"es\")\nText");
        assert!(output.mutations.iter().any(|item| {
            item.kind == MutationKind::SetRule
                && item
                    .language
                    .as_ref()
                    .is_some_and(|value| value.confidence == ValueConfidence::Dynamic)
        }));
        assert!(output
            .mutations
            .iter()
            .any(|item| item.kind == MutationKind::ShowRule));
    }

    #[test]
    fn excludes_non_prose_and_splits_escaped_direct_strings() {
        let source = "word `raw` $math$ // comment\n#text(lang: \"en\", \"one\\ntwo\")";
        let output = parse(source);
        let slices = output
            .prose_ranges
            .iter()
            .map(|range| {
                String::from_utf16_lossy(
                    &source.encode_utf16().collect::<Vec<_>>()[range.from_utf16..range.to_utf16],
                )
            })
            .collect::<Vec<_>>();
        assert!(slices.iter().any(|slice| slice.contains("word")));
        assert!(!slices.iter().any(|slice| slice.contains("raw")
            || slice.contains("math")
            || slice.contains("comment")));
        assert!(slices.iter().any(|slice| slice == "one"));
        assert!(slices.iter().any(|slice| slice == "two"));
    }

    #[test]
    fn malformed_source_invalidates_the_remainder_of_its_scope() {
        let output = parse("#text(lang: \"fr\")[unfinished");
        assert!(!output.syntax_errors.is_empty());
        assert!(output
            .mutations
            .iter()
            .any(|item| item.kind == MutationKind::SyntaxError));
    }

    #[test]
    fn literal_false_set_is_excluded_and_spreads_are_dynamic() {
        let output = parse(
            "#set text(lang: \"fr\") if false\n#set text(..style)\n#text(lang: language)[body]",
        );
        assert!(!output.mutations.iter().any(|item| {
            item.language
                .as_ref()
                .and_then(|value| value.value.as_deref())
                == Some("fr")
        }));
        assert!(output
            .mutations
            .iter()
            .filter_map(|item| item.language.as_ref())
            .all(|value| { value.confidence == ValueConfidence::Dynamic }));
    }

    #[test]
    fn nested_content_and_code_scopes_restore_at_their_lexical_end() {
        let source =
            "#set text(lang: \"en\")\nouter\n#block[\n  #set text(lang: \"km\")\n  inner\n]\nafter";
        let output = parse(source);
        let outer = output
            .mutations
            .iter()
            .find(|item| {
                item.language
                    .as_ref()
                    .and_then(|value| value.value.as_deref())
                    == Some("en")
            })
            .unwrap();
        let inner = output
            .mutations
            .iter()
            .find(|item| {
                item.language
                    .as_ref()
                    .and_then(|value| value.value.as_deref())
                    == Some("km")
            })
            .unwrap();
        assert_eq!(outer.apply_to_utf16, source.encode_utf16().count());
        let after = source.find("after").unwrap();
        assert!(inner.apply_to_utf16 <= source[..after].encode_utf16().count());

        let code = parse("#{ set text(lang: \"fr\"); [bonjour] } outside");
        let french = code
            .mutations
            .iter()
            .find(|item| item.kind == MutationKind::SetRule)
            .unwrap();
        assert!(
            french.apply_to_utf16
                < "#{ set text(lang: \"fr\"); [bonjour] } outside"
                    .encode_utf16()
                    .count()
        );
    }

    #[test]
    fn shadowed_text_is_unresolved_and_alias_calls_are_not_builtin_scopes() {
        let output = parse(
            "#let text = custom\n#text(lang: \"fr\")[body]\n#let local-text = text\n#local-text(lang: \"es\")[body]",
        );
        assert_eq!(output.mutations.len(), 1);
        assert_eq!(output.mutations[0].kind, MutationKind::TextCall);
        assert_eq!(
            output.mutations[0].language.as_ref().unwrap().confidence,
            ValueConfidence::Dynamic
        );
    }

    #[test]
    fn named_anonymous_and_generic_content_keep_only_prose_nodes() {
        let source = "#block[Named content #emph[inside]]\n#[Anonymous content]\n#custom[Generic content]\n#let code = \"not prose\"";
        let output = parse(source);
        let slices = output
            .prose_ranges
            .iter()
            .map(|range| &source[range.from_utf16..range.to_utf16])
            .collect::<Vec<_>>();
        for word in ["Named", "content", "inside", "Anonymous", "Generic"] {
            assert!(
                slices
                    .iter()
                    .any(|slice| slice.split_whitespace().any(|part| part == word)),
                "missing prose node {word:?} in {slices:?}"
            );
        }
        assert!(!slices.iter().any(|slice| slice.contains("not prose")));
    }

    #[test]
    fn randomized_incomplete_edits_never_publish_out_of_bounds_ranges() {
        let mut source =
            "#set text(lang: \"en\")\n#text(lang: \"fr\")[Bonjour 😀]\n#[ខ្មែរ]".to_string();
        let mut seed = 0x51_7a_5a_7a_u64;
        for step in 0..160 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let boundaries = source
                .char_indices()
                .map(|(index, _)| index)
                .chain([source.len()])
                .collect::<Vec<_>>();
            let byte = boundaries[(seed as usize) % boundaries.len()];
            if step % 3 == 0 && !source.is_empty() && byte < source.len() {
                let end = source[byte..]
                    .char_indices()
                    .nth(1)
                    .map_or(source.len(), |(next, _)| byte + next);
                source.replace_range(byte..end, "");
            } else {
                source.insert_str(byte, if step % 2 == 0 { "#" } else { "😀" });
            }
            let output = parse(&source);
            for range in output
                .prose_ranges
                .iter()
                .chain(output.syntax_errors.iter())
            {
                assert!(range.from_utf16 <= range.to_utf16);
                assert!(range.to_utf16 <= output.document_utf16);
            }
            for mutation in &output.mutations {
                assert!(mutation.apply_from_utf16 <= mutation.apply_to_utf16);
                assert!(mutation.apply_to_utf16 <= output.document_utf16);
            }
        }
    }

    #[test]
    fn parser_cost_stays_bounded_for_phase_two_stress_documents() {
        let long_document = "multilingual prose 😀 សួស្តី مرحبا. ".repeat(3_500);
        let long_output = parse(&long_document);
        assert!(long_document.len() >= 100_000);
        assert_eq!(
            long_output.document_utf16,
            long_document.encode_utf16().count()
        );

        let declarations = (0..1_000)
            .map(|index| {
                format!(
                    "#set text(lang: \"{}\")\nword {index}\n",
                    if index % 2 == 0 { "en" } else { "fr" }
                )
            })
            .collect::<String>();
        let declaration_output = parse(&declarations);
        assert_eq!(declaration_output.mutations.len(), 1_000);
        eprintln!(
            "language-scope benchmarks: 100k={}us, 1000-declarations={}us",
            long_output.elapsed_micros, declaration_output.elapsed_micros,
        );
        // These are regression tripwires, not performance claims. Published
        // measurements below use release-mode runs on named hardware.
        assert!(long_output.elapsed_micros < 2_000_000);
        assert!(declaration_output.elapsed_micros < 2_000_000);
    }
}
