use super::sourcemap::{MappingKind, SourceMap};
use khmer_segmenter::kdict::KHypDict;
use khmer_segmenter::{KhmerSegmenter, SegmentationLength, SegmenterConfig};

const KHMER_DICTIONARY: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_dictionary.kdict");
const KHMER_HYPHENATION: &[u8] =
    include_bytes!("../../../third_party/khmer_segmenter/port/common/khmer_hyphenation.kdict");
pub struct KhmerTextSegmenter {
    pub segmenter: KhmerSegmenter,
    pub hyphenation: KHypDict,
}

const INVERSE_SYNC_BOUNDARY: &str = "#[]";

fn contains_khmer(text: &str) -> bool {
    text.chars().any(is_khmer_character)
}

fn is_khmer_character(character: char) -> bool {
    ('\u{1780}'..='\u{17ff}').contains(&character)
}

fn append_original_run(
    output: &mut String,
    text: &str,
    source_start: usize,
    current_gen_offset: &mut usize,
    sourcemap: &mut SourceMap,
    add_inverse_sync_boundaries: bool,
) {
    let mut chunk_start = 0;
    for (index, character) in text.char_indices() {
        let chunk_end = index + character.len_utf8();
        let is_between_khmer = text[..index]
            .chars()
            .next_back()
            .is_some_and(is_khmer_character)
            && text[chunk_end..]
                .chars()
                .next()
                .is_some_and(is_khmer_character);
        if !add_inverse_sync_boundaries || character != ' ' || !is_between_khmer {
            continue;
        }
        let chunk = &text[chunk_start..chunk_end];
        output.push_str(chunk);
        sourcemap.add_mapping(
            *current_gen_offset,
            *current_gen_offset + chunk.len(),
            source_start + chunk_start,
            source_start + chunk_end,
            MappingKind::Original,
        );
        *current_gen_offset += chunk.len();

        output.push_str(INVERSE_SYNC_BOUNDARY);
        sourcemap.add_mapping(
            *current_gen_offset,
            *current_gen_offset + INVERSE_SYNC_BOUNDARY.len(),
            source_start + chunk_end,
            source_start + chunk_end,
            MappingKind::GeneratedWrapper,
        );
        *current_gen_offset += INVERSE_SYNC_BOUNDARY.len();
        chunk_start = chunk_end;
    }

    if chunk_start < text.len() {
        let chunk = &text[chunk_start..];
        output.push_str(chunk);
        sourcemap.add_mapping(
            *current_gen_offset,
            *current_gen_offset + chunk.len(),
            source_start + chunk_start,
            source_start + text.len(),
            MappingKind::Original,
        );
        *current_gen_offset += chunk.len();
    }
}

/// Splits Khmer markup at visible spaces into separate Typst source spans.
/// `#[]` has no layout output, but avoids an upstream inverse-sync failure
/// where glyphs after the first space resolve to the end of the whole line.
pub fn prepare_markup_for_inverse_sync(
    input: &str,
    source_offset: usize,
    generated_offset_start: usize,
    sourcemap: &mut SourceMap,
) -> String {
    let mut output = String::new();
    let mut generated_offset = generated_offset_start;
    append_original_run(
        &mut output,
        input,
        source_offset,
        &mut generated_offset,
        sourcemap,
        contains_khmer(input),
    );
    output
}

impl KhmerTextSegmenter {
    pub fn new() -> Result<Self, String> {
        let mut config = SegmenterConfig::default();
        config.segmentation_length = SegmentationLength::Short;
        let segmenter = KhmerSegmenter::from_bytes(KHMER_DICTIONARY.to_vec(), config)
            .map_err(|error| format!("Failed to load Khmer dictionary: {}", error))?;
        let hyphenation = KHypDict::from_bytes(KHMER_HYPHENATION.to_vec())
            .map_err(|error| format!("Failed to load Khmer hyphenation dictionary: {}", error))?;
        Ok(Self {
            segmenter,
            hyphenation,
        })
    }
}

fn layout_parts<'a>(
    source_text: &'a str,
    normalized_text: &str,
    hyphenation: &KHypDict,
) -> Vec<&'a str> {
    if let Some(hyphenated) = hyphenation.lookup(normalized_text) {
        let hyphenation_parts: Vec<&str> = hyphenated
            .split('\u{200b}')
            .filter(|part| !part.is_empty())
            .collect();
        if hyphenation_parts.len() > 1 {
            let joined: String = hyphenation_parts.concat();
            if joined == source_text {
                let mut parts = Vec::with_capacity(hyphenation_parts.len());
                let mut cursor = 0;
                for part in hyphenation_parts {
                    let end = cursor + part.len();
                    if !source_text.is_char_boundary(cursor) || !source_text.is_char_boundary(end) {
                        return vec![source_text];
                    }
                    parts.push(&source_text[cursor..end]);
                    cursor = end;
                }
                if cursor == source_text.len() {
                    return parts;
                }
            }
        }
    }

    vec![source_text]
}

pub fn prepare_khmer_text_for_rendering(
    input: &str,
    segmenter: &KhmerSegmenter,
    hyphenation: &KHypDict,
    source_offset: usize,
    generated_offset_start: usize,
    sourcemap: &mut SourceMap,
    scope: super::scanner::ScopeState,
) -> String {
    let mut output = String::new();
    let mut current_gen_offset = generated_offset_start;
    let add_inverse_sync_boundaries = contains_khmer(input);

    let mut chars = input.char_indices().peekable();

    while let Some(&(start_idx, c)) = chars.peek() {
        let is_khmer = ('\u{1780}'..='\u{17ff}').contains(&c);
        let start_run = start_idx;
        let mut end_run = start_idx + c.len_utf8();
        chars.next();

        while let Some(&(next_idx, next_c)) = chars.peek() {
            let next_is_khmer = ('\u{1780}'..='\u{17ff}').contains(&next_c);
            if next_is_khmer == is_khmer {
                end_run = next_idx + next_c.len_utf8();
                chars.next();
            } else {
                break;
            }
        }

        let run_text = &input[start_run..end_run];
        let run_source_start = source_offset + start_run;
        let run_source_end = source_offset + end_run;

        if is_khmer && scope.par_justify && !scope.render_prep_disabled {
            if let Ok(segmentation) = segmenter.segment_detailed(run_text) {
                let segments = segmentation.mapped_segments();
                if segments.is_empty() {
                    let gen_len = run_text.len();
                    output.push_str(run_text);
                    sourcemap.add_mapping(
                        current_gen_offset,
                        current_gen_offset + gen_len,
                        run_source_start,
                        run_source_end,
                        MappingKind::Original,
                    );
                    current_gen_offset += gen_len;
                } else {
                    for (seg_idx, segment) in segments.iter().enumerate() {
                        let seg_source_range = &segment.source_range;
                        let normalized_text =
                            &segmentation.normalized()[segment.normalized_range.clone()];
                        let seg_text = &run_text[seg_source_range.clone()];
                        let seg_source_end = run_source_start + seg_source_range.end;
                        let layout_parts = layout_parts(seg_text, normalized_text, hyphenation);
                        let mut part_source_cursor = run_source_start + seg_source_range.start;

                        for (part_idx, part) in layout_parts.iter().enumerate() {
                            let part_len = part.len();
                            let part_source_start = part_source_cursor;
                            let part_source_end = part_source_start + part_len;

                            output.push_str(part);
                            sourcemap.add_mapping(
                                current_gen_offset,
                                current_gen_offset + part_len,
                                part_source_start,
                                part_source_end,
                                MappingKind::Original,
                            );
                            current_gen_offset += part_len;
                            part_source_cursor = part_source_end;

                            if part_idx + 1 < layout_parts.len() {
                                let boundary_char = "\u{200b}";
                                output.push_str(boundary_char);
                                let boundary_len = boundary_char.len();
                                sourcemap.add_mapping(
                                    current_gen_offset,
                                    current_gen_offset + boundary_len,
                                    part_source_end,
                                    part_source_end,
                                    MappingKind::InsertedZws,
                                );
                                current_gen_offset += boundary_len;
                            }
                        }

                        if seg_idx + 1 < segments.len() {
                            let boundary_char = "\u{200b}";
                            output.push_str(boundary_char);
                            let boundary_len = boundary_char.len();
                            sourcemap.add_mapping(
                                current_gen_offset,
                                current_gen_offset + boundary_len,
                                seg_source_end,
                                seg_source_end,
                                MappingKind::InsertedZws,
                            );
                            current_gen_offset += boundary_len;
                        }
                    }
                }
            } else {
                let gen_len = run_text.len();
                output.push_str(run_text);
                sourcemap.add_mapping(
                    current_gen_offset,
                    current_gen_offset + gen_len,
                    run_source_start,
                    run_source_end,
                    MappingKind::Original,
                );
                current_gen_offset += gen_len;
            }
        } else {
            append_original_run(
                &mut output,
                run_text,
                run_source_start,
                &mut current_gen_offset,
                sourcemap,
                add_inverse_sync_boundaries,
            );
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cooperation_word() -> &'static str {
        "\u{179f}\u{17a0}\u{1794}\u{17d2}\u{179a}\u{178f}\u{17b7}\
         \u{1794}\u{178f}\u{17d2}\u{178f}\u{17b7}\u{1780}\u{17b6}\u{179a}"
    }

    fn university_word() -> &'static str {
        "\u{179f}\u{17b6}\u{1780}\u{179b}\u{179c}\u{17b7}\u{1791}\u{17d2}\
         \u{1799}\u{17b6}\u{179b}\u{17d0}\u{1799}"
    }

    fn remove_layout_controls(text: &str) -> String {
        text.replace('\u{200b}', "")
    }

    #[test]
    fn test_khmer_zws_insertion_uses_internal_layout_breaks() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = cooperation_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };
        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert_eq!(remove_layout_controls(&output), source);
        assert!(
            output.contains('\u{200b}'),
            "expected internal ZWSP layout breaks in {output:?}"
        );
        assert!(!map.mappings.is_empty());
    }

    #[test]
    fn test_khmer_hyphenation_inserts_internal_zws_breaks() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = university_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());

        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };
        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert!(
            output.contains('\u{200b}'),
            "expected internal ZWSP layout breaks from hyphenation data in {output:?}"
        );
        assert_eq!(remove_layout_controls(&output), source);
        assert!(!map.mappings.is_empty());
    }

    #[test]
    fn test_khmer_layout_splits_common_long_dictionary_tokens() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: false,
        };

        for source in ["ភាសាខ្មែរ", "ភាសាផ្លូវការ", "ប្រើប្រាស់", "ប្រចាំថ្ងៃ"]
        {
            let output = prepare_khmer_text_for_rendering(
                source,
                &segmenter.segmenter,
                &segmenter.hyphenation,
                0,
                0,
                &mut map,
                scope,
            );
            assert!(
                output.contains('\u{200b}'),
                "expected a ZWSP layout split for {source:?}: {output:?}"
            );
            assert_eq!(remove_layout_controls(&output), source);
        }
    }

    #[test]
    fn test_disable_render_prep_scope_leaves_khmer_text_unchanged() {
        let segmenter = KhmerTextSegmenter::new().unwrap();
        let source = cooperation_word();
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let scope = crate::render_prepare::scanner::ScopeState {
            par_justify: true,
            render_prep_disabled: true,
        };

        let output = prepare_khmer_text_for_rendering(
            source,
            &segmenter.segmenter,
            &segmenter.hyphenation,
            0,
            0,
            &mut map,
            scope,
        );

        assert_eq!(output, source);
        assert!(!output.contains('\u{200b}'));
    }

    #[test]
    fn test_inverse_sync_boundaries_split_khmer_markup_without_source_text() {
        let source = "\u{1781}\u{17d2}\u{1798}\u{17c2}\u{179a} \u{1782}\u{17ba}\u{1787}\u{17b6}";
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let output = prepare_markup_for_inverse_sync(source, 0, 0, &mut map);

        assert_eq!(output.replace(INVERSE_SYNC_BOUNDARY, ""), source);
        assert!(output.contains(&format!(" {}", INVERSE_SYNC_BOUNDARY)));

        let second_word_source = source.find('\u{1782}').unwrap();
        let second_word_generated = output.find('\u{1782}').unwrap();
        assert_eq!(
            map.generated_to_source(second_word_generated),
            Some(second_word_source)
        );
        assert_eq!(
            map.source_to_generated(second_word_source),
            Some(second_word_generated)
        );
    }

    #[test]
    fn test_inverse_sync_boundaries_leave_non_khmer_markup_unchanged() {
        let source = "Latin text remains unchanged.";
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let output = prepare_markup_for_inverse_sync(source, 0, 0, &mut map);

        assert_eq!(output, source);
        assert!(!output.contains(INVERSE_SYNC_BOUNDARY));
    }

    #[test]
    fn test_inverse_sync_boundaries_never_enter_typst_code_or_heading_prefixes() {
        let source = "#set par(justify: true)\n= \u{1781}\u{17d2}\u{1798}\u{17c2}\u{179a}\n\u{1781}\u{17d2}\u{1798}\u{17c2}\u{179a} \u{1782}\u{17ba}\u{1787}\u{17b6}";
        let mut map = SourceMap::new("src.typ".into(), "dest.typ".into());
        let output = prepare_markup_for_inverse_sync(source, 0, 0, &mut map);

        assert!(output.starts_with("#set par(justify: true)\n= \u{1781}"));
        assert!(output.ends_with(
            "\u{1781}\u{17d2}\u{1798}\u{17c2}\u{179a} #[]\u{1782}\u{17ba}\u{1787}\u{17b6}"
        ));
        assert_eq!(output.matches(INVERSE_SYNC_BOUNDARY).count(), 1);
    }
}
